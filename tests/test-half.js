/* ============================================================================
 * test-half.js —— 巡检频率「一年2次」（按半年考核）专项回归
 * 覆盖：频率选项存在与保存 / 半年窗口判定（Q1Q2=上半年，Q3Q4=下半年）/
 *       跨季度同窗口结果一致 / result=other 不计入 / 半年 × 分组 /
 *       详情徽标与 KPI 口径 / CSV 考核口径与次数 / 一年4次口径不受影响。
 * ==========================================================================*/
const { JSDOM, VirtualConsole } = require('jsdom');
const { html, mkUser } = require('./test-helpers-server');
const STORE = 'inspection_board_v1';
const PREF = 'inspection_board_pref_v1';

const USERS = { version: 1, users: [
  mkUser({ username: 'demo', name: '演示用户', role: 'user', password: 'demo888' })
] };

const errors = [];
const results = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }

/* 固定场景：今天 = 2026-10-12（2026Q4 → 下半年 H2） */
const SEED = {
  regions: [{ id: 'r1', name: '测试区', color: '#2563EB', provinces: ['河北'] }],
  customers: [
    { id: 'h1', name: '半年-下半年已巡', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.60, lat: 37.70, freq: 'y2', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'h2', name: '半年-只巡上半年', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.61, lat: 37.71, freq: 'y2', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'h3', name: '半年-仅有未巡检记录', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.62, lat: 37.72, freq: 'y2', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'h4', name: '半年-两分组只巡一组', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.63, lat: 37.73, freq: 'y2', contact: '', phone: '', note: '', hasCoords: true,
      units: [ { id: 'k1', name: '核心网络组', owner: '张三', note: '' }, { id: 'k2', name: '卡片业务组', owner: '李四', note: '' } ] },
    { id: 'q1', name: '季度-下半年只在7月', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.64, lat: 37.74, freq: 'y4', contact: '', phone: '', note: '', hasCoords: true }
  ],
  visits: [
    { id: 'v1', customerId: 'h1', date: '2026-07-15', by: '', note: '' },   /* 下半年 · Q3 */
    { id: 'v2', customerId: 'h2', date: '2026-03-10', by: '', note: '' },   /* 上半年 · Q1 */
    { id: 'v3', customerId: 'h3', date: '2026-08-01', by: '', note: '', result: 'other' },
    { id: 'v4', customerId: 'h4', date: '2026-09-05', by: '', note: '', unitIds: ['k1'] },
    { id: 'v5', customerId: 'q1', date: '2026-07-20', by: '', note: '' }
  ]
};

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://127.0.0.1:8899/inspection-dashboard.html',
  pretendToBeVisual: true,
  beforeParse(window) {
    const FIXED = new Date('2026-10-12T10:00:00+08:00').getTime();
    const RealDate = window.Date;
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [FIXED])); }
      static now() { return FIXED; }
    };
    window.localStorage.setItem('inspection_board_users_v1', JSON.stringify(USERS));
    window.sessionStorage.setItem('inspection_board_token_v1', 'test-token');
    window.localStorage.setItem(STORE + '::demo', JSON.stringify(SEED));
    window.localStorage.setItem(PREF + '::demo', JSON.stringify({ autoRemind: false, mutedQuarters: [] }));
    require('./test-helpers-server').installApiStub(window, { sessionUser: 'demo' });
  },
  virtualConsole: new VirtualConsole().on('jsdomError', e => {
    if (/Not implemented/.test(e.message)) return;
    errors.push(e.message);
  })
});

const w = dom.window, d = w.document;
const id = x => d.getElementById(x);
const click = el => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const fire = (el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true }));
const store = () => JSON.parse(w.localStorage.getItem(STORE + '::demo'));
const card = cid => d.querySelector('.card-cust[data-id="' + cid + '"]');
const badgeOf = cid => { const el = card(cid); return el ? el.querySelector('.badge').textContent.trim() : '(无卡片)'; };
const setQuarter = q => { id('quarterSel').value = q; fire(id('quarterSel'), 'change'); };

(async () => {
  await new Promise(r => {
    if (d.readyState === 'complete') return r();
    d.addEventListener('DOMContentLoaded', () => setTimeout(r, 30));
    setTimeout(() => r(), 4000);
  });
  await new Promise(r => setTimeout(r, 60));

  /* ---------- 1. 频率选项 ---------- */
  const opts = [...d.querySelectorAll('#freqOpts .freq-opt')];
  check('频率选项共 3 个', opts.length === 3, String(opts.length));
  check('新增「一年 2 次」选项',
    opts.some(b => b.getAttribute('data-freq') === 'y2' && /一年\s*2\s*次/.test(b.textContent)));
  check('「一年 2 次」标注按半年考核',
    /半年/.test((opts.filter(b => b.getAttribute('data-freq') === 'y2')[0] || {}).textContent || ''));

  /* ---------- 2. 半年口径判定（当前 Q4 → 下半年） ---------- */
  check('下半年有 1 次 → 本半年已巡检', badgeOf('h1') === '本半年已巡检 1/1', badgeOf('h1'));
  check('只有上半年记录 → 本半年未巡检', badgeOf('h2') === '本半年未巡检 0/1', badgeOf('h2'));
  check('result=other 不计入半年判定', badgeOf('h3') === '本半年未巡检 0/1', badgeOf('h3'));
  check('半年 × 分组只巡一组 → 部分 1/2 组', badgeOf('h4') === '本半年部分 1/2 组', badgeOf('h4'));
  check('一年4次口径不受影响（7 月记录不算 Q4）', badgeOf('q1') === '未巡检 0/1', badgeOf('q1'));

  /* ---------- 3. 跨季度同窗口结果一致 ---------- */
  setQuarter('2026Q3');
  check('切到 Q3（同属下半年）→ 仍达标', badgeOf('h1') === '本半年已巡检 1/1', badgeOf('h1'));
  check('切到 Q3 → 上半年客户仍未巡检', badgeOf('h2') === '本半年未巡检 0/1', badgeOf('h2'));

  setQuarter('2026Q2');
  check('切到 Q2（上半年）→ 3 月那次算数', badgeOf('h2') === '本半年已巡检 1/1', badgeOf('h2'));
  check('切到 Q2 → 下半年客户未巡检', badgeOf('h1') === '本半年未巡检 0/1', badgeOf('h1'));

  setQuarter('2026Q1');
  check('切到 Q1（上半年）→ 与 Q2 同结果', badgeOf('h2') === '本半年已巡检 1/1', badgeOf('h2'));

  /* ---------- 4. 详情弹窗口径 ---------- */
  setQuarter('2026Q4');
  click(card('h1'));
  check('详情徽标按半年表述', id('dStatus').textContent === '本半年已巡检', id('dStatus').textContent);
  const kpi = [...id('dKpiRow').children].map(td => td.textContent.trim());
  check('KPI 首格显示所属半年', kpi[0] === '2026 年下半年', kpi[0]);
  check('KPI 已巡次数取半年次数', kpi[1] === '1 次', kpi[1]);
  check('KPI 目标显示「每半年 1 次」', kpi[2] === '每半年 1 次', kpi[2]);
  check('KPI 年度目标仍为 2 次', kpi[4] === '2 次', kpi[4]);

  click(card('h4'));
  const uth = d.querySelector('#dUnitsTable thead th:nth-child(3)');
  check('分组表头跟随口径（本半年状态）', uth && uth.textContent === '本半年状态', uth && uth.textContent);
  check('分组表标题写明本半年', /本半年/.test(id('dUnitsCaption').textContent), id('dUnitsCaption').textContent);
  click(d.querySelector('#maskDetail [data-close]'));

  /* ---------- 5. 新建客户可选并保存「一年 2 次」 ---------- */
  click(id('btnAdd'));
  click(d.querySelector('#freqOpts .freq-opt[data-freq="y2"]'));
  id('fName').value = '半年新增客户';
  id('fLng').value = '116.40';
  id('fLat').value = '39.90';
  click(id('btnSaveCust'));
  {
    const nc = store().customers.filter(c => c.name === '半年新增客户')[0];
    check('保存后频率落库为 y2', !!nc && nc.freq === 'y2', nc && nc.freq);
    check('新客户初始未巡检（半年口径）', !!nc && badgeOf(nc.id) === '本半年未巡检 0/1', nc && badgeOf(nc.id));
    /* 不同频率之间可来回切换 */
    click(d.querySelector('.card-cust[data-id="' + nc.id + '"]'));
    click(id('btnEditCust'));
    click(d.querySelector('#freqOpts .freq-opt[data-freq="y4"]'));
    click(id('btnSaveCust'));
    const nc2 = store().customers.filter(c => c.name === '半年新增客户')[0];
    check('改回一年4次后口径回到按季度', !!nc2 && nc2.freq === 'y4', nc2 && nc2.freq);
  }

  /* ---------- 6. CSV 导出口径 ---------- */
  click(id('btnExport'));
  {
    const box = id('exBox');
    const csv = box ? box.value : '';
    check('CSV 含半年考核口径', /按半年（每半年1次）/.test(csv), csv.slice(0, 160));
    check('CSV 表头改为「考核窗口」口径', /考核窗口目标\(次\)/.test(csv) && /窗口内已巡检\(次\)/.test(csv));
    const row = csv.split(/\r?\n/).filter(l => l.indexOf('半年-下半年已巡') === 0)[0] || '';
    check('CSV 中该客户窗口内次数 = 1', /,按半年（每半年1次）,1,1,/.test(row), row);
  }

  /* ---------- 汇总 ---------- */
  const fails = results.filter(r => r[0] === 'FAIL');
  console.log('\n===== 通过 ' + (results.length - fails.length) + ' / 共 ' + results.length + ' =====');
  results.forEach(r => { if (r[0] === 'FAIL') console.log('FAIL | ' + r[1] + ' | ' + (r[2] || '')); });
  if (errors.length) { console.log('JS 错误：'); errors.forEach(e => console.log('  ' + e)); }
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch(e => { console.error('测试执行异常：', e); process.exit(1); });
