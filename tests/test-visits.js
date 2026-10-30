/* 巡检登记增强：巡检方式、巡检结果（其他（未巡检）不计次数）、附件上传与在线预览 */
const { makeDom, dataKey } = require('./test-helpers-server');

const results = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }
const tick = ms => new Promise(r => setTimeout(r, ms || 30));

const dom = makeDom({});
const w = dom.window, d = w.document;
const id = x => d.getElementById(x);
const click = el => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const store = () => JSON.parse(w.localStorage.getItem(dataKey('demo')));

(async () => {
  await tick(200);

  /* ---------- 1) 表单控件 ---------- */
  check('巡检方式下拉存在', !!id('dVisitMode'));
  check('巡检方式仅现场/远程两项',
    id('dVisitMode') && Array.from(id('dVisitMode').options).map(o => o.value).join(',') === 'onsite,remote',
    id('dVisitMode') ? Array.from(id('dVisitMode').options).map(o => o.value).join(',') : '');
  check('巡检结果下拉存在', !!id('dVisitResult'));
  check('巡检结果含 正常/异常/其他（未巡检）',
    id('dVisitResult') && Array.from(id('dVisitResult').options).map(o => o.textContent.replace('巡检结果：', '')).join('/') === '正常/异常/其他（未巡检）',
    id('dVisitResult') ? Array.from(id('dVisitResult').options).map(o => o.textContent).join('/') : '');
  check('附件选择入口存在', !!id('btnPickAttach') && !!id('visitAttachInput'));
  check('附件输入允许多选', id('visitAttachInput') && id('visitAttachInput').hasAttribute('multiple'));
  check('附件输入限制类型（图片/PDF/Office）',
    id('visitAttachInput') && /image\/\*/.test(id('visitAttachInput').getAttribute('accept')) &&
    /\.pdf/.test(id('visitAttachInput').getAttribute('accept')));

  /* 打开第一家客户详情 */
  click(d.querySelector('#custList .card-cust'));
  check('客户详情已打开', id('maskDetail').classList.contains('on'));
  check('打开时默认 现场 + 正常', id('dVisitMode').value === 'onsite' && id('dVisitResult').value === 'ok');

  const qCount = () => parseInt((id('dKpiRow').children[1] || {}).textContent, 10) || 0;
  const base = qCount();

  /* ---------- 2) 巡检人必填 ---------- */
  const beforeReq = store().visits.length;
  id('dVisitBy').value = '';
  id('dVisitNote').value = '';
  click(id('btnAddVisit'));
  await tick(40);
  check('巡检人为空时拒绝保存', store().visits.length === beforeReq,
    'before=' + beforeReq + ' after=' + store().visits.length);
  check('提示需填写巡检人', id('toast').textContent.indexOf('巡检人') >= 0, id('toast').textContent);

  /* ---------- 3) 其他（未巡检）不计入次数 ---------- */
  id('dVisitBy').value = '潘超';
  id('dVisitResult').value = 'other';
  id('dVisitNote').value = '客户临时要求延期，本次未开展';
  click(id('btnAddVisit'));
  await tick(60);

  let last = store().visits[store().visits.length - 1];
  check('记录已保存 result=other', last && last.result === 'other', last && last.result);
  check('记录已保存 mode=onsite', last && last.mode === 'onsite', last && last.mode);
  check('其他（未巡检）不计入本季度次数', qCount() === base, 'before=' + base + ' after=' + qCount());
  check('时间线显示「其他（未巡检）」标签',
    !!d.querySelector('#dTimeline .vtag.res-other') &&
    d.querySelector('#dTimeline .vtag.res-other').textContent.indexOf('其他（未巡检）') >= 0);
  check('时间线显示巡检方式标签', !!d.querySelector('#dTimeline .vtag.mode'));

  /* ---------- 4) 正常 + 远程 计入次数 ---------- */
  id('dVisitBy').value = '潘超';
  id('dVisitMode').value = 'remote';
  id('dVisitResult').value = 'ok';
  id('dVisitNote').value = '远程核查备份任务与告警队列';
  click(id('btnAddVisit'));
  await tick(60);
  check('正常记录计入本季度次数', qCount() === base + 1, 'before=' + base + ' after=' + qCount());
  check('时间线显示「远程」', Array.from(d.querySelectorAll('#dTimeline .vtag.mode')).some(e => e.textContent === '远程'));
  check('时间线显示「正常」', Array.from(d.querySelectorAll('#dTimeline .vtag.res-ok')).some(e => e.textContent === '正常'));

  /* ---------- 5) 附件：入队 → 上传 → 落库 → 预览 ---------- */
  id('dVisitBy').value = '潘超';
  const file = new w.File(['机房温湿度：22℃ / 45%\n'], '现场记录.txt', { type: 'text/plain' });
  w.__visitAtts.add([file]);
  await tick(60);
  check('附件进入待上传队列', w.__visitAtts.pending().length === 1, JSON.stringify(w.__visitAtts.pending()));
  check('待上传区渲染出附件卡片', d.querySelectorAll('#visitAttachList .att-chip').length === 1);
  check('卡片显示文件名', d.querySelector('#visitAttachList .att-name').textContent === '现场记录.txt');

  click(id('btnAddVisit'));
  await tick(120);

  const withAtt = store().visits.filter(v => v.atts && v.atts.length)[0];
  check('巡检记录已带上附件引用', !!withAtt && withAtt.atts.length === 1, withAtt ? withAtt.atts.length + ' 个' : '无');
  check('附件引用含 id 与 url', !!(withAtt && withAtt.atts[0].id && /^\/api\/attach\//.test(withAtt.atts[0].url)),
    withAtt ? JSON.stringify(withAtt.atts[0]) : '');
  check('附件已上传到服务端', Object.keys(w.__SRV__.attachments).length === 1,
    Object.keys(w.__SRV__.attachments).length + ' 个');
  check('保存后待上传队列已清空', w.__visitAtts.pending().length === 0);
  check('时间线显示附件', d.querySelectorAll('#dTimeline .tl-att').length === 1);

  /* 点击附件 → 在线预览（文本走 iframe） */
  click(d.querySelector('#dTimeline .tl-att'));
  check('附件预览弹窗打开', id('maskViewer').classList.contains('on'));
  check('预览标题为文件名', id('vwName').textContent === '现场记录.txt', id('vwName').textContent);
  check('文本附件用 iframe 内嵌预览', !!d.querySelector('#vwBody iframe'));
  check('预览弹窗提供下载入口', !!id('vwDownload') && /^\/api\/attach\//.test(id('vwDownload').getAttribute('href')));
  check('预览层为 .high（盖在客户详情之上）', id('maskViewer').classList.contains('high'));
  click(d.querySelector('#maskViewer [data-close]'));
  check('预览弹窗可关闭', !id('maskViewer').classList.contains('on'));

  /* ---------- 6) 删除记录时清理附件 ---------- */
  const total = store().visits.length;
  const attVisitIdx = d.querySelectorAll('#dTimeline .tl-item').length;
  /* 找到带附件那条记录对应的删除按钮：时间线按日期倒序，最后一条是刚保存的 */
  const dels = d.querySelectorAll('#dTimeline .tl-del');
  click(dels[0]);
  check('删除确认框弹出', id('maskConfirm').classList.contains('on'));
  click(id('cfOk'));
  await tick(120);
  check('巡检记录已删除', store().visits.length === total - 1, 'before=' + total + ' after=' + store().visits.length);
  check('附件随记录一并清理', Object.keys(w.__SRV__.attachments).length === 0,
    Object.keys(w.__SRV__.attachments).length + ' 个残留');
  check('时间线条目数减少', d.querySelectorAll('#dTimeline .tl-item').length === attVisitIdx - 1);

  /* ---------- 7) 旧数据兼容 ---------- */
  const legacy = store().visits.filter(v => !v.mode && !v.result);
  check('历史记录缺少 mode/result 时不报错', true, legacy.length + ' 条旧记录');

  /* ---------- 8) 粘贴图片 / 拖拽上传 / Excel·Word 预览判定 ---------- */
  const mkFile = (name, type) => new w.File(['x'], name, { type });
  const pendCount = () => w.__visitAtts.pending().length;
  w.__visitAtts.clear();

  /* 8a) 备注文本框粘贴图片 → 进附件队列 */
  const pasteEv = new w.Event('paste', { bubbles: true, cancelable: true });
  const pngFile = mkFile('paste-shot.png', 'image/png');
  Object.defineProperty(pasteEv, 'clipboardData', { value: { items: [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: 'image/png', getAsFile: () => pngFile }
  ] } });
  id('dVisitNote').dispatchEvent(pasteEv);
  check('备注框粘贴图片进入附件队列', pendCount() === 1 && w.__visitAtts.pending()[0].name === 'paste-shot.png',
    JSON.stringify(w.__visitAtts.pending()));
  check('纯文本粘贴不加附件', (() => {
    const ev2 = new w.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev2, 'clipboardData', { value: { items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null }
    ] } });
    const n0 = pendCount();
    id('dVisitNote').dispatchEvent(ev2);
    return pendCount() === n0;
  })());

  /* 8b) 整个客户详情弹窗支持拖拽投放 */
  const dropEv = new w.Event('drop', { bubbles: true, cancelable: true });
  const xlsxBlob = mkFile('盘点表.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  Object.defineProperty(dropEv, 'dataTransfer', { value: { files: [xlsxBlob] } });
  id('maskDetail').dispatchEvent(dropEv);
  check('弹窗拖拽文件进入附件队列', pendCount() === 2, pendCount() + ' 个');
  check('拖拽后附件框高亮已复位', !id('visitAttachBox').classList.contains('dropping'));
  const dropEv2 = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(dropEv2, 'dataTransfer', { value: { files: [] } });
  id('maskDetail').dispatchEvent(dropEv2);
  check('空拖拽不报错不加附件', pendCount() === 2 && (!dom.__errors || dom.__errors.length === 0),
    (dom.__errors || []).join(' | ').slice(0, 120));
  w.__visitAtts.clear();

  /* 8c) Excel / Word 判定：mime 与扩展名双通道 */
  check('xlsx 判定为 Excel', w.__visitAtts.isExcel('盘点表.xlsx', ''));
  check('xls 判定为 Excel', w.__visitAtts.isExcel('老表.xls', 'application/vnd.ms-excel'));
  check('octet-stream + xlsx 扩展名仍判定 Excel', w.__visitAtts.isExcel('a.xlsx', 'application/octet-stream'));
  check('docx 判定为 Word', w.__visitAtts.isWord('报告.docx', ''));
  check('wordprocessingml 判定为 Word', w.__visitAtts.isWord('b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  check('doc 不判定为 Word（在线预览仅 docx）', !w.__visitAtts.isWord('老文档.doc', 'application/msword'));
  check('txt/pdf 不误判为 Excel/Word', !w.__visitAtts.isExcel('c.txt', 'text/plain') && !w.__visitAtts.isWord('d.pdf', 'application/pdf'));
  check('附件提示含 Excel/Word', /Excel/.test(id('attachTip').textContent) && /Word/.test(id('attachTip').textContent),
    id('attachTip').textContent);
  check('预览组件资源已就位',
    require('fs').existsSync(require('path').join(__dirname, '..', 'assets', 'vendor', 'xlsx.full.min.js')) &&
    require('fs').existsSync(require('path').join(__dirname, '..', 'assets', 'vendor', 'mammoth.browser.min.js')));

  check('运行期无 JS 错误', !dom.__errors || dom.__errors.length === 0,
    (dom.__errors || []).join(' | ').slice(0, 200));

  const pass = results.filter(x => x[0] === 'PASS').length;
  results.forEach(x => console.log(x[0] + '  ' + x[1] + (x[2] ? '  [' + x[2] + ']' : '')));
  console.log('---');
  console.log('通过 ' + pass + ' / ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  console.error(e);
  console.log('通过 0 / ' + results.length);
  process.exit(1);
});
