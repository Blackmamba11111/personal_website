/* 弹窗防误关：只读弹窗点遮罩直接关；表单弹窗有改动先问一句；
   Esc 只关最上层；拖选文字不误判为「点击遮罩」。 */
const fs = require('fs');
const path = require('path');
const { makeDom } = require('./test-helpers-server');

const results = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }
const tick = ms => new Promise(r => setTimeout(r, ms || 30));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'inspection-dashboard.html'), 'utf8');

const dom = makeDom({});
const w = dom.window, d = w.document;
const id = x => d.getElementById(x);
const clk = el => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const on = x => id(x).classList.contains('on');
/* 模拟真实点遮罩：目标就是遮罩本身 */
const clickMask = x => {
  const m = id(x);
  m.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
};
const typeIn = el => el.dispatchEvent(new w.Event('input', { bubbles: true }));
const key = k => d.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
const pressDownOn = el => el.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
const errors = [];
w.addEventListener('error', e => errors.push(String(e.message || e)));

(async () => {
  await tick(240);

  /* ---------- 1) 只读弹窗：点遮罩直接关 ---------- */
  id('maskRemind').classList.add('on');
  check('只读弹窗（巡检提醒）已打开', on('maskRemind'));
  clickMask('maskRemind');
  check('只读弹窗点遮罩直接关闭（不二次确认）',
    !on('maskRemind') && !on('maskConfirm'));

  /* ---------- 2) 表单弹窗 · 没改动：静默关闭 ---------- */
  clk(d.querySelector('#custList .card-cust'));
  check('客户详情已打开', on('maskDetail'));
  clickMask('maskDetail');
  check('未做任何输入时点遮罩直接关闭', !on('maskDetail'), 'still on: ' + on('maskDetail'));
  check('未改动时不弹确认框', !on('maskConfirm'));

  /* ---------- 3) 表单弹窗 · 有改动：先问一句 ---------- */
  clk(d.querySelector('#custList .card-cust'));
  id('dVisitBy').value = '潘超';
  typeIn(id('dVisitBy'));
  clickMask('maskDetail');
  check('有改动时点遮罩不直接关闭', on('maskDetail'));
  check('弹出「放弃填写的内容」确认', on('maskConfirm'));
  check('确认文案点名未保存内容', /没保存/.test(id('cfMsg').textContent), id('cfMsg').textContent);
  check('确认按钮为「放弃并关闭」', id('cfOk').textContent === '放弃并关闭', id('cfOk').textContent);
  check('取消按钮为「继续填写」', id('cfCancel').textContent === '继续填写', id('cfCancel').textContent);

  /* 继续填写 → 什么都不丢 */
  clk(id('cfCancel'));
  check('点「继续填写」后弹窗仍在', on('maskDetail') && !on('maskConfirm'));
  check('已填内容不丢', id('dVisitBy').value === '潘超', id('dVisitBy').value);

  /* 再来一次 → 确认放弃 */
  clickMask('maskDetail');
  check('二次点遮罩仍会拦截', on('maskDetail') && on('maskConfirm'));
  clk(id('cfOk'));
  check('确认放弃后弹窗关闭', !on('maskDetail') && !on('maskConfirm'));

  /* 改动标记随关闭复位 */
  clk(d.querySelector('#custList .card-cust'));
  clickMask('maskDetail');
  check('关闭后改动标记复位（再开可直接关）', !on('maskDetail') && !on('maskConfirm'));

  /* ---------- 4) 拖选文字不误判 ---------- */
  clk(d.querySelector('#custList .card-cust'));
  pressDownOn(id('dVisitBy'));      /* 在弹窗内按下 … */
  clickMask('maskDetail');          /* … 拖到遮罩上松手 */
  check('弹窗内按下、遮罩上松手不算点击遮罩', on('maskDetail') && !on('maskConfirm'));
  clickMask('maskDetail');          /* 真正的点击（无按下记录） */
  check('随后的正常点击遮罩生效', !on('maskDetail'));

  /* ---------- 5) Esc 只关最上层 ---------- */
  clk(d.querySelector('#custList .card-cust'));
  id('maskViewer').classList.add('on');           /* 详情之上叠一层预览 */
  key('Escape');
  check('Esc 只关最上层（预览关闭）', !on('maskViewer'));
  check('下层详情仍在（不再连坐）', on('maskDetail'));

  id('dVisitNote').value = '机房环境正常';
  typeIn(id('dVisitNote'));
  key('Escape');
  check('有改动时 Esc 也先问一句', on('maskDetail') && on('maskConfirm'));
  key('Escape');                                   /* 确认框上的 Esc = 继续填写 */
  check('确认框上按 Esc 只关确认框', !on('maskConfirm') && on('maskDetail'));
  clk(id('maskDetail').querySelector('[data-close]'));
  check('点 × 属主动关闭，不再二次确认', !on('maskDetail') && !on('maskConfirm'));

  /* ---------- 6) 客户抽屉：按钮组类改动也能识别 ---------- */
  clk(id('btnAdd'));
  check('新增客户抽屉已打开', on('maskCust'));
  clk(d.querySelector('#freqOpts .freq-opt[data-freq="y12"]'));
  key('Escape');
  check('自定义按钮组算改动（Esc 被拦）', on('maskCust') && on('maskConfirm'),
    'cust=' + on('maskCust') + ' cf=' + on('maskConfirm'));
  clk(id('cfOk'));
  check('确认后抽屉关闭', !on('maskCust'));

  clk(id('btnAdd'));
  clk(id('btnAddUnit'));
  key('Escape');
  check('新增分组行也算改动（Esc 被拦）', on('maskConfirm'));
  clk(id('cfOk'));
  check('确认后抽屉关闭（分组行已丢弃）', !on('maskCust'));

  /* ---------- 7) 结构守卫 ---------- */
  check('确认框层级压过 .high 弹窗（z-index 350）',
    /#maskConfirm\{z-index:350;\}/.test(SRC));
  check('遮罩点击记录按下位置（pointerdown）',
    /pointerdown[\s\S]{0,80}maskDown\[m\.id\] = e\.target/.test(SRC));
  check('8 个表单弹窗纳入拦截名单',
    /var FORM_MASKS = \[[\s\S]{0,200}'maskPwd'\]/.test(SRC) &&
    ['maskCust', 'maskDetail', 'maskImport', 'maskRegion', 'maskUser', 'maskBatchUser', 'maskServer', 'maskPwd']
      .every(x => SRC.indexOf("'" + x + "'") >= 0));
  check('旧的「点遮罩即关」逻辑已移除',
    SRC.indexOf("m.onclick = function (e) { if (e.target === m) m.classList.remove('on'); }") < 0);

  /* ---------- 汇总 ---------- */
  const fails = results.filter(r => r[0] === 'FAIL');
  console.log('\n===== 通过 ' + (results.length - fails.length) + ' / 共 ' + results.length + ' =====');
  results.forEach(r => { if (r[0] === 'FAIL') console.log('FAIL | ' + r[1] + ' | ' + (r[2] || '')); });
  if (errors.length) { console.log('JS 错误：'); errors.forEach(e => console.log('  ' + e)); }
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch(e => { console.error('测试执行异常：', e); process.exit(1); });
