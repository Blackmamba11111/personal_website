/* 边界与降级路径测试 */
const { makeDom: mkDom, dataKey } = require('./test-helpers-server');

const results = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }

/* seed 为「demo 用户」的台账片段；以普通用户 demo 身份登录 */
function makeDom(seed) {
  return mkDom({ data: seed ? { demo: seed } : null });
}
const click = (w, el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (w, k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));

// ---------- 第 1 轮：地图信息窗委托 + 降级 ----------
const dom1 = makeDom(null);
const w1 = dom1.window, d1 = w1.document;
setTimeout(() => {
  check('地图未加载时展示降级提示', d1.getElementById('mapFail').classList.contains('on'));

  // 地图未就绪时点击「拾取坐标」不应静默无反应
  click(w1, d1.getElementById('btnAdd'));
  click(w1, d1.getElementById('btnPick'));
  check('地图未就绪时拾取坐标给出提示（不静默）',
    d1.getElementById('maskCust').classList.contains('on') && d1.getElementById('toast').classList.contains('on'),
    'toast: ' + d1.getElementById('toast').textContent);
  click(w1, d1.querySelector('#maskCust [data-close]'));

  // 模拟地图 SDK 渲染出的信息窗按钮（无内联 onclick，仅 data-act）
  const iw = d1.createElement('div');
  iw.innerHTML = '<span data-act="detail" data-id="c03" style="cursor:pointer">查看 / 登记巡检</span>';
  d1.body.appendChild(iw);
  const btn = iw.querySelector('[data-act="detail"]');
  click(w1, btn);
  check('地图信息窗按钮委托生效（打开客户详情）', d1.getElementById('maskDetail').classList.contains('on'));
  check('委托定位到正确客户', d1.getElementById('dName').textContent === '衡水银行总行',
    d1.getElementById('dName').textContent);

  // Esc 关闭
  key(w1, 'Escape');
  check('Esc 可关闭弹窗', !d1.getElementById('maskDetail').classList.contains('on'));

  // 编辑客户资料
  click(w1, d1.querySelector('#custList .card-cust'));
  click(w1, d1.getElementById('btnEditCust'));
  check('「编辑客户资料」打开表单并回填', d1.getElementById('maskCust').classList.contains('on')
    && d1.getElementById('fName').value.length > 0, d1.getElementById('fName').value);
  click(w1, d1.querySelector('#maskCust [data-close]'));

  // ---------- 第 2 轮：数据持久化 ----------
  const saved = JSON.parse(w1.localStorage.getItem(dataKey('demo')));
  const dom2 = makeDom(saved);
  setTimeout(() => {
    const d2 = dom2.window.document;
    check('重新加载后数据持久化', d2.getElementById('stTotal').textContent === String(saved.customers.length),
      d2.getElementById('stTotal').textContent + ' / ' + saved.customers.length);

    // 空数据兜底
    const dom3 = makeDom({ customers: [], visits: [] });
    setTimeout(() => {
      const d3 = dom3.window.document;
      check('空数据时不报错并给出引导', d3.getElementById('stTotal').textContent === '0'
        && d3.getElementById('custList').textContent.indexOf('暂无客户') >= 0);
      check('空数据时统计不出现 NaN', d3.getElementById('progTxt').textContent === '0%',
        d3.getElementById('progTxt').textContent);

      const pass = results.filter(r => r[0] === 'PASS').length;
      results.forEach(r => console.log(r[0] + '  ' + r[1] + (r[2] ? '   [' + r[2] + ']' : '')));
      console.log('\n===== ' + pass + ' / ' + results.length + ' 通过 =====');
      process.exit(pass === results.length ? 0 : 1);
    }, 700);
  }, 700);
}, 800);
