/* ============================================================================
 * test-op-ui.js —— 运营中心「项目技术信息」页面（assets/op-tech.js）渲染回归
 * 覆盖：账号菜单入口注入与权限可见性 / 打开与返回 / 表头 10 列 /
 *       按项目 rowspan 合并 / 小计行 colspan 合计 / 计数文案 / 失败清单 /
 *       令牌状态 / 全字段与指定字段检索 / 空结果占位 /
 *       xlsx 导出的 aoa 结构、合并区域、列宽、Sheet 名与文件名。
 * 全部走注入的假桥接（window.__opBridge）与假 XLSX，不访问网络。
 * 运行：node tests/test-op-ui.js
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'assets/op-tech.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

const COLS = ['序号', '项目名称', '维护人A', '维护人B', '网络环境', '产品类型', '数量', '软件版本', '操作系统', '功能模块', '组网架构', '备注'];

const FIX = [
  {
    name: '中国银行股份有限公司', accountName: '中国银行', mainA: '潘超', mainB: '张璐', total: 3, rows: [
      { env: '生产网', product: '硬件-S8100H', count: 2, version: 'V3.2.1', os: 'Linux', module: 'DNS、DHCP', ha: '主备', note: '' },
      { env: '测试网', product: '纯软件', count: 1, version: 'V3.0', os: 'Linux', module: 'DNS', ha: '单机', note: '仅测试' }
    ]
  },
  {
    name: '衡水银行股份有限公司', accountName: '衡水银行', mainA: '赵鹏', mainB: '', total: 4, rows: [
      { env: '生产网', product: '硬件-S6100', count: 4, version: 'V2.9', os: 'Linux', module: 'DNS', ha: '集群', note: '' }
    ]
  }
];

/* 起一个最小页面：只需要 #userMenu + #umCrm 两个锚点 */
function boot(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html><head></head><body>' +
    '<div class="umenu" id="userMenu"><button type="button" id="umCrm">CRM 台账关联</button></div>' +
    '<div id="host"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  const calls = [];
  const captured = {};
  win.__calls = calls;
  win.__captured = captured;
  win.__opBridge = {
    api: function (p) {
      calls.push(p);
      if (p.indexOf('/op/config') === 0) {
        return Promise.resolve({
          ok: true, data: {
            owner: 'panchao', auto: true, intervalHours: 12, configured: true,
            username: '潘超', leftSec: 7260, lastSyncAt: '2026-11-20T06:00:00.000Z'
          }
        });
      }
      if (p.indexOf('/op/rows') === 0) {
        return Promise.resolve({
          ok: true, data: {
            customers: opts.empty ? [] : FIX,
            failed: opts.empty ? [] : [{ name: '华泰人寿保险股份有限公司', message: '运营中心无匹配客户' }],
            updatedAt: '2026-11-20T06:00:00.000Z', total: 7
          }
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    },
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    },
    toast: function (m) { calls.push('toast:' + m); },
    fmtTs: function (s) { return 'TS(' + s + ')'; },
    isAdmin: function () { return opts.admin !== false; },
    users: function () { return [{ username: 'panchao', name: '潘超' }, { username: 'zhaopeng', name: '赵鹏' }]; },
    vendor: function () {
      return opts.noVendor ? Promise.reject(new Error('导出组件不可用')) : Promise.resolve();
    }
  };
  win.XLSX = {
    utils: {
      aoa_to_sheet: function (aoa) {
        captured.aoa = aoa;
        var ws = {};
        aoa.forEach(function (row, r) {
          row.forEach(function (v, c) {
            ws[String.fromCharCode(65 + c) + (r + 1)] = { t: typeof v === 'number' ? 'n' : 's', v: v };
          });
        });
        captured.ws = ws;
        return ws;
      },
      encode_cell: function (ref) { return String.fromCharCode(65 + ref.c) + (ref.r + 1); },
      book_new: function () { return {}; },
      book_append_sheet: function (wb, ws, name) { captured.sheet = name; }
    },
    writeFile: function (wb, name) { captured.name = name; }
  };
  /* 导出改走 xlsx-js-style：测试直接注入，跳过脚本加载；noVendor 注入无 utils 的库验证降级 */
  win.__opXjsLib = opts.noVendor ? { noUtils: true } : win.XLSX;
  win.eval(CODE);
  return { dom, win, doc, calls, captured };
}

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 30); }); }

function textOf(tr) {
  return Array.prototype.map.call(tr.children, function (td) {
    return (td.getAttribute('colspan') ? '[' + td.getAttribute('colspan') + ']' : '') + td.textContent;
  }).join('|');
}
function spanSum(tr) {
  return Array.prototype.reduce.call(tr.children, function (s, td) {
    return s + Number(td.getAttribute('colspan') || 1);
  }, 0);
}

(async function main() {
  /* ---------- 1. 入口注入与权限 ---------- */
  {
    const { doc } = boot({});
    await tick(20);
    const btn = doc.getElementById('umOp');
    check('入口按钮已注入账号菜单', !!btn);
    check('入口文本为「项目技术信息」', btn && btn.textContent === '项目技术信息', btn && btn.textContent);
    check('入口位于「CRM 台账关联」之后', btn && btn.previousElementSibling && btn.previousElementSibling.id === 'umCrm',
      btn && btn.previousElementSibling && btn.previousElementSibling.id);
  }
  {
    const { doc } = boot({ admin: false });
    await tick(20);
    const btn = doc.getElementById('umOp');
    check('非超管时入口隐藏', !!btn && btn.style.display === 'none', btn && btn.style.display);
  }
  {
    const { doc } = boot({});
    await tick(20);
    check('超管时入口可见', doc.getElementById('umOp').style.display === 'block', doc.getElementById('umOp').style.display);
  }

  /* ---------- 2. 打开 / 返回 / 表头 ---------- */
  const { win, doc, calls, captured } = boot({});
  await tick(20);
  const btnOp = doc.getElementById('umOp');
  doc.getElementById('userMenu').classList.add('on');
  btnOp.click();
  await tick(40);

  const view = doc.getElementById('opView');
  check('点击后打开功能页', !!view && view.classList.contains('on'));
  check('打开时收起账号菜单', !doc.getElementById('userMenu').classList.contains('on'));
  check('配置接口被调用', calls.indexOf('/op/config') >= 0, calls.join(','));
  check('数据接口带 owner 参数', calls.some(function (p) { return p.indexOf('/op/rows?owner=panchao') === 0; }), calls.join(','));

  const ths = Array.prototype.map.call(view.querySelectorAll('#opTable thead th'), function (th) { return th.textContent; });
  check('表头为 12 列且与附件口径一致', ths.length === 12 && ths.every(function (t, i) { return t === COLS[i]; }), ths.join('/'));
  check('基准用户下拉已填充', view.querySelectorAll('#opOwner option').length === 2);
  check('基准用户选中配置中的 owner', doc.getElementById('opOwner').value === 'panchao', doc.getElementById('opOwner').value);
  check('定时开关回填配置', doc.getElementById('opAuto').checked === true);
  check('间隔回填配置', doc.getElementById('opInterval').value === '12', doc.getElementById('opInterval').value);

  /* ---------- 3. 表格结构 ---------- */
  const trs = view.querySelectorAll('#opTable tbody tr');
  check('行数 = 数据行 3 + 小计行 2', trs.length === 5, String(trs.length));
  const r0 = trs[0], r1 = trs[1], r2 = trs[2];
  check('首行序号/项目名/维护人A/维护人B 各占 rowspan=2',
    [0, 1, 2, 3].every(function (i) { return r0.children[i].getAttribute('rowspan') === '2'; }));
  check('维护人 A、B 取客户级字段',
    r0.children[2].textContent === '潘超' && r0.children[3].textContent === '张璐',
    r0.children[2].textContent + '/' + r0.children[3].textContent);
  check('首行序号为 1', r0.children[0].textContent === '1', r0.children[0].textContent);
  check('首行项目名取客户名', r0.children[1].textContent === '中国银行股份有限公司', r0.children[1].textContent);
  check('首行数据列顺序正确',
    textOf(r0).indexOf('生产网|硬件-S8100H') >= 0, textOf(r0));
  check('续行只有 8 个单元格（序号/项目由 rowspan 覆盖）',
    r1.children.length === 8 && !r1.children[0].getAttribute('rowspan'), String(r1.children.length));
  check('续行内容属于同一项目的第二行', textOf(r1).indexOf('测试网|纯软件') >= 0, textOf(r1));
  check('小计行 colspan 合计 12', spanSum(r2) === 12, String(spanSum(r2)));
  check('小计行首格为「小计」', r2.children[0].textContent === '小计', r2.children[0].textContent);
  check('小计数量 = 该项目各行数量之和', r2.children[3].textContent === '3', r2.children[3].textContent);
  const last = trs[4];
  check('第二个项目也带小计行', last.children[0].textContent === '小计' && last.children[3].textContent === '4',
    textOf(last));

  /* ---------- 4. 计数 / 失败清单 / 令牌状态 ---------- */
  check('项目计数正确', doc.getElementById('opCount').textContent === '2', doc.getElementById('opCount').textContent);
  check('行计数正确', doc.getElementById('opRows').textContent === '3', doc.getElementById('opRows').textContent);
  check('数据时间用 fmtTs 格式化',
    doc.getElementById('opSyncAt').textContent === '数据时间 TS(2026-11-20T06:00:00.000Z)',
    doc.getElementById('opSyncAt').textContent);
  check('失败清单列出客户与原因',
    /华泰人寿保险股份有限公司（运营中心无匹配客户）/.test(doc.getElementById('opFailed').textContent),
    doc.getElementById('opFailed').textContent);
  check('令牌状态显示账号与剩余时长',
    /已配置（账号：潘超）/.test(doc.getElementById('opTokenState').textContent) &&
    /剩余 2 小时 1 分/.test(doc.getElementById('opTokenState').textContent),
    doc.getElementById('opTokenState').textContent);

  /* ---------- 5. 检索 ---------- */
  const q = doc.getElementById('opQ');
  const field = doc.getElementById('opField');
  q.value = '测试网';
  q.dispatchEvent(new win.Event('input'));
  check('全字段检索命中单个项目（1 数据行 + 1 小计行）',
    view.querySelectorAll('#opTable tbody tr').length === 2,
    String(view.querySelectorAll('#opTable tbody tr').length));
  check('检索后小计随之收敛', view.querySelectorAll('#opTable tbody tr')[1].children[3].textContent === '1');

  field.value = 'product';
  field.dispatchEvent(new win.Event('change'));
  q.value = '纯软件';
  q.dispatchEvent(new win.Event('input'));
  check('指定「产品类型」字段检索有效', view.querySelectorAll('#opTable tbody tr').length === 2,
    String(view.querySelectorAll('#opTable tbody tr').length));

  field.value = 'os';
  field.dispatchEvent(new win.Event('change'));
  q.value = 'Windows';
  q.dispatchEvent(new win.Event('input'));
  check('无命中时输出占位行', view.querySelectorAll('#opTable tbody tr').length === 1 &&
    view.querySelector('#opTable tbody tr td').getAttribute('colspan') === '12');

  q.value = '';
  q.dispatchEvent(new win.Event('input'));
  field.value = 'all';
  field.dispatchEvent(new win.Event('change'));
  check('清空检索后恢复全量', view.querySelectorAll('#opTable tbody tr').length === 5);

  /* ---------- 6. 导出 ---------- */
  doc.getElementById('btnOpExport').click();
  await tick(50);
  const aoa = captured.aoa || [];
  check('导出被触发', !!captured.aoa);
  check('表头与页面 12 列一致', aoa[0] && aoa[0].join('/') === COLS.join('/'), aoa[0] && aoa[0].join('/'));
  check('导出数据行数 = 3 数据行 + 2 小计行', aoa.length === 6, String(aoa.length));
  check('首个数据行序号为 1、项目名为客户名', aoa[1][0] === 1 && aoa[1][1] === '中国银行股份有限公司',
    JSON.stringify(aoa[1]));
  check('导出带维护人 A、B 两列', aoa[1][2] === '潘超' && aoa[1][3] === '张璐', JSON.stringify(aoa[1]));
  check('同项目续行序号/项目名/维护人留空',
    aoa[2][0] === '' && aoa[2][1] === '' && aoa[2][2] === '' && aoa[2][3] === '', JSON.stringify(aoa[2]));
  check('小计行首格为「小计」且数量在 G 列', aoa[3][0] === '小计' && aoa[3][6] === 3, JSON.stringify(aoa[3]));
  const merges = captured.ws['!merges'] || [];
  check('两行项目的客户级四列都纵向合并',
    [0, 1, 2, 3].every(function (c) {
      return merges.some(function (m) { return m.s.r === 1 && m.e.r === 2 && m.s.c === c && m.e.c === c; });
    }), JSON.stringify(merges));
  check('小计行 A:D 合并', merges.some(function (m) {
    return m.s.r === 3 && m.e.r === 3 && m.s.c === 0 && m.e.c === 3;
  }), JSON.stringify(merges));
  check('单行项目不做横向合并（只合并小计）',
    merges.filter(function (m) { return m.s.r === m.e.r; }).length === 2, JSON.stringify(merges));
  check('列宽为 12 项', (captured.ws['!cols'] || []).length === 12);
  check('列宽按附件口径换算（A 列 9.62 → wch 8.79）',
    Math.abs(captured.ws['!cols'][0].wch - 8.79) < 0.01, String(captured.ws['!cols'][0].wch));
  check('行高：表头 34、数据行 16.8',
    captured.ws['!rows'][0].hpt === 34 && captured.ws['!rows'][1].hpt === 16.8,
    JSON.stringify(captured.ws['!rows'].slice(0, 2)));

  /* ---------- 6b. 导出样式（复刻附件） ---------- */
  const wsx = captured.ws;
  check('表头字体微软雅黑 11 加粗白字',
    wsx['A1'].s.font.name === '微软雅黑' && wsx['A1'].s.font.sz === 11 &&
    wsx['A1'].s.font.bold === true && wsx['A1'].s.font.color.rgb === 'FFFFFFFF',
    JSON.stringify(wsx['A1'].s.font));
  check('表头底色 4472C4、居中、细边框',
    wsx['A1'].s.fill.fgColor.rgb === 'FF4472C4' && wsx['A1'].s.alignment.horizontal === 'center' &&
    wsx['A1'].s.border.left.style === 'thin', JSON.stringify(wsx['A1'].s));
  check('序号列底色 C9D9F0 深蓝字', wsx['A2'].s.fill.fgColor.rgb === 'FFC9D9F0' &&
    wsx['A2'].s.font.color.rgb === 'FF1F3864', JSON.stringify(wsx['A2'].s));
  check('项目名称列加粗', wsx['B2'].s.font.bold === true, JSON.stringify(wsx['B2'].s.font));
  check('维护人列与客户级同底色', wsx['C2'].s.fill.fgColor.rgb === 'FFC9D9F0' &&
    wsx['D2'].s.fill.fgColor.rgb === 'FFC9D9F0');
  check('设备列底色 E9F0FB、左对齐',
    wsx['E2'].s.fill.fgColor.rgb === 'FFE9F0FB' && wsx['E2'].s.alignment.horizontal === 'left',
    JSON.stringify(wsx['E2'].s));
  check('数量列居中且整数格式', wsx['G2'].s.alignment.horizontal === 'center' && wsx['G2'].z === '0');
  check('备注列按附件为宋体无底色', wsx['L2'].s.font.name === '宋体' && !wsx['L2'].s.fill,
    JSON.stringify(wsx['L2'].s));
  check('小计行首组为蓝色 B4C7E7', wsx['A4'].s.fill.fgColor.rgb === 'FFB4C7E7' &&
    wsx['A4'].s.font.color.rgb === 'FF1F3864', JSON.stringify(wsx['A4'].s));
  check('小计行第二组轮换为绿色 C6E0B4', wsx['A6'].s.fill.fgColor.rgb === 'FFC6E0B4',
    JSON.stringify(wsx['A6'] && wsx['A6'].s));
  check('小计数量写成 SUM 公式', wsx['G4'].f === 'SUM(G2:G3)', JSON.stringify(wsx['G4']));
  check('Sheet 名为「项目信息梳理」', captured.sheet === '项目信息梳理', captured.sheet);
  check('文件名带基准用户与时间戳',
    /^项目信息-panchao-\d{8}-\d{4}\.xlsx$/.test(captured.name || ''), captured.name);
  check('导出成功有提示', calls.some(function (c) { return /^toast:已导出 /.test(c); }), calls.filter(function (c) { return c.indexOf('toast:') === 0; }).join(','));

  /* ---------- 7. 空数据与导出降级 ---------- */
  {
    const s = boot({ empty: true });
    await tick(20);
    s.doc.getElementById('umOp').click();
    await tick(40);
    const rows = s.doc.querySelectorAll('#opTable tbody tr');
    check('无数据时显示 12 列占位行', rows.length === 1 && rows[0].children[0].getAttribute('colspan') === '12',
      String(rows.length));
    check('无数据时项目计数为 0', s.doc.getElementById('opCount').textContent === '0');
    s.doc.getElementById('btnOpExport').click();
    await tick(30);
    check('无数据导出被拦截并提示', s.calls.indexOf('toast:没有可导出的数据') >= 0, s.calls.join(','));
    s.win.close();
  }
  {
    const s = boot({ noVendor: true });
    await tick(20);
    s.doc.getElementById('umOp').click();
    await tick(40);
    s.doc.getElementById('btnOpExport').click();
    await tick(40);
    check('导出组件加载失败时提示且按钮复位',
      s.calls.some(function (c) { return c === 'toast:导出组件不可用'; }) &&
      s.doc.getElementById('btnOpExport').disabled === false, s.calls.join(','));
    s.win.close();
  }

  win.close();
  console.log('\n通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '，失败 ' + fail : ''));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
