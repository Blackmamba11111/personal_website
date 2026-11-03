/* ============================================================================
 * test-units.js —— 巡检分组（客户内部分组，可选）专项回归
 * 覆盖：未分组客户行为不变 / 分组客户完成度三态（0/n、部分、全部）/
 *       整体巡检（unitIds 空）覆盖全部 / result=other 不计入 /
 *       y12 按月考核 × 分组（当月全部组覆盖才算月达标）/
 *       客户表单分组编辑（新增/空名拦截/重名去重/删除）/
 *       详情弹窗分组表 + 巡检对象勾选 + 时间线分组标签。
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

/* 固定场景：今天 = 2026-10-12（2026Q4，已到月份仅 10 月） */
const SEED = {
  regions: [{ id: 'r1', name: '测试区', color: '#2563EB', provinces: ['河北'] }],
  customers: [
    { id: 'c0', name: '普通-无分组', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.60, lat: 37.70, freq: 'y4', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'c1', name: '分组-三组未巡', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.61, lat: 37.71, freq: 'y4', contact: '', phone: '', note: '', hasCoords: true,
      units: [ { id: 'k1', name: '核心网络组', owner: '张三', note: '' }, { id: 'k2', name: '卡片业务组', owner: '李四', note: '' }, { id: 'k3', name: '安防监控组', owner: '', note: '' } ] },
    { id: 'c2', name: '分组-只巡一组', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.62, lat: 37.72, freq: 'y4', contact: '', phone: '', note: '', hasCoords: true,
      units: [ { id: 'k1', name: '核心网络组', owner: '张三', note: '' }, { id: 'k2', name: '卡片业务组', owner: '李四', note: '' }, { id: 'k3', name: '安防监控组', owner: '', note: '' } ] },
    { id: 'c3', name: '分组-整体巡检', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.63, lat: 37.73, freq: 'y4', contact: '', phone: '', note: '', hasCoords: true,
      units: [ { id: 'k1', name: '机房A', owner: '', note: '' }, { id: 'k2', name: '机房B', owner: '', note: '' } ] },
    { id: 'c4', name: '分组-只有未巡检记录', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.64, lat: 37.74, freq: 'y4', contact: '', phone: '', note: '', hasCoords: true,
      units: [ { id: 'k1', name: '组一', owner: '', note: '' }, { id: 'k2', name: '组二', owner: '', note: '' } ] },
    { id: 'c5', name: '月度分组-10月缺一组', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.65, lat: 37.75, freq: 'y12', contact: '', phone: '', note: '', hasCoords: true,
      units: [ { id: 'k1', name: '组一', owner: '', note: '' }, { id: 'k2', name: '组二', owner: '', note: '' } ] },
    { id: 'c6', name: '月度分组-10月全覆盖', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.66, lat: 37.76, freq: 'y12', contact: '', phone: '', note: '', hasCoords: true,
      units: [ { id: 'k1', name: '组一', owner: '', note: '' }, { id: 'k2', name: '组二', owner: '', note: '' } ] }
  ],
  visits: [
    { id: 'v0', customerId: 'c0', date: '2026-10-05', by: '', note: '' },
    { id: 'v2', customerId: 'c2', date: '2026-10-06', by: '', note: '', unitIds: ['k1'] },
    { id: 'v3', customerId: 'c3', date: '2026-10-06', by: '', note: '', unitIds: [] },
    { id: 'v4', customerId: 'c4', date: '2026-10-07', by: '', note: '', result: 'other', unitIds: ['k1'] },
    { id: 'v5', customerId: 'c5', date: '2026-10-08', by: '', note: '', unitIds: ['k1'] },
    { id: 'v6a', customerId: 'c6', date: '2026-10-09', by: '', note: '', unitIds: ['k1'] },
    { id: 'v6b', customerId: 'c6', date: '2026-10-09', by: '', note: '', unitIds: ['k2'] }
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
const unitChecks = () => [...d.querySelectorAll('#dVisitUnits input')];

(async () => {
  await new Promise(r => {
    if (d.readyState === 'complete') return r();
    d.addEventListener('DOMContentLoaded', () => setTimeout(r, 30));
    setTimeout(() => r(), 4000);   /* 兜底：页面近 600KB，必须等 readyState complete */
  });
  await new Promise(r => setTimeout(r, 60));

  /* ---------- 1. 未分组客户：行为与旧版一致 ---------- */
  check('未分组客户正常渲染卡片', !!card('c0'));
  check('未分组客户一条整体巡检即达标', badgeOf('c0') === '已巡检 1/1', badgeOf('c0'));

  /* ---------- 2. 分组客户三态 ---------- */
  check('三组未巡 → 未巡检 0/3 组', badgeOf('c1') === '未巡检 0/3 组', badgeOf('c1'));
  check('只巡一组 → 部分 1/3 组', badgeOf('c2') === '部分 1/3 组', badgeOf('c2'));
  check('整体巡检（unitIds 空）→ 全部完成 2/2 组', badgeOf('c3') === '全部完成 2/2 组', badgeOf('c3'));
  check('result=other 不计入 → 未巡检 0/2 组', badgeOf('c4') === '未巡检 0/2 组', badgeOf('c4'));

  /* ---------- 3. y12 按月 × 分组 ---------- */
  {
    const strip = card('c5').querySelector('.mstrip');
    const oct = strip ? strip.querySelectorAll('.mcell')[0] : null;
    check('月度分组客户当月只巡一组 → 该月未达标', !!oct && oct.className.indexOf('lack') >= 0,
      oct && oct.className);
    check('月度分组缺月 → 文案「未巡检 0/1 月」', badgeOf('c5') === '未巡检 0/1 月', badgeOf('c5'));
  }
  {
    const strip = card('c6').querySelector('.mstrip');
    const oct = strip ? strip.querySelectorAll('.mcell')[0] : null;
    check('月度分组客户当月两组全覆盖 → 该月达标', !!oct && oct.className.indexOf('done') >= 0,
      oct && oct.className);
    check('月度全覆盖 → 月度达标 1/1', badgeOf('c6') === '月度达标 1/1', badgeOf('c6'));
  }

  /* ---------- 4. 详情弹窗：分组表 + 巡检对象勾选 ---------- */
  click(card('c2'));
  check('详情弹窗打开', id('maskDetail').classList.contains('on'));
  check('详情徽标提示部分分组已巡检 1/3',
    /部分分组已巡检 1\/3/.test(id('dStatus').textContent), id('dStatus').textContent);
  check('分组信息块显示', id('dUnits').style.display === 'block');
  check('分组表 3 行', d.querySelectorAll('#dUnitsTable tbody tr').length === 3,
    d.querySelectorAll('#dUnitsTable tbody tr').length + '');
  check('分组表标注张三为负责人', /张三/.test(d.querySelector('#dUnitsTable tbody').textContent));
  {
    const tr1 = d.querySelectorAll('#dUnitsTable tbody tr')[0];
    check('已巡分组标注「已巡检」', /已巡检/.test(tr1.textContent));
    const tr2 = d.querySelectorAll('#dUnitsTable tbody tr')[1];
    check('未巡分组标注「未巡检」', /未巡检/.test(tr2.textContent));
  }
  check('巡检对象勾选区显示', id('dVisitUnitsWrap').style.display === 'block');
  check('巡检对象默认全选（3 个）', unitChecks().length === 3 && unitChecks().every(x => x.checked),
    unitChecks().length + '');

  /* ---------- 5. 登记部分分组巡检 ---------- */
  id('dVisitBy').value = '潘超';
  unitChecks()[0].checked = false;   /* 核心网络组（已有记录） */
  unitChecks()[2].checked = false;   /* 安防监控组 */
  click(id('btnAddVisit'));
  {
    const db = store();
    const nv = db.visits.filter(v => v.customerId === 'c2' && v.by === '潘超')[0];
    check('部分勾选保存成功（新记录入台账）', !!nv);
    check('新记录 unitIds 仅含勾选的 k2', !!nv && JSON.stringify(nv.unitIds) === '["k2"]',
      nv && JSON.stringify(nv.unitIds));
    check('登记后徽标变为部分分组已巡检 2/3',
      /部分分组已巡检 2\/3/.test(id('dStatus').textContent), id('dStatus').textContent);
    check('时间线新记录带分组标签「卡片业务组」',
      /unit-tag/.test(id('dTimeline').innerHTML) && /卡片业务组/.test(id('dTimeline').innerHTML));
  }

  /* ---------- 6. 全选登记 = 整体巡检（unitIds 存空数组） ---------- */
  id('dVisitBy').value = '潘超';
  unitChecks().forEach(x => { x.checked = true; });
  click(id('btnAddVisit'));
  {
    const db = store();
    const nv = db.visits.filter(v => v.customerId === 'c2').sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    check('全选保存 → unitIds 存空数组（整体巡检）', !!nv && Array.isArray(nv.unitIds) && nv.unitIds.length === 0,
      nv && JSON.stringify(nv.unitIds));
  }

  /* ---------- 7. 一个都不勾 → 拦截 ---------- */
  id('dVisitBy').value = '潘超';
  unitChecks().forEach(x => { x.checked = false; });
  const cntBefore = store().visits.length;
  click(id('btnAddVisit'));
  check('全部取消勾选时拦截保存', store().visits.length === cntBefore,
    store().visits.length + ' vs ' + cntBefore);
  check('拦截提示文案', /请至少勾选一个/.test(id('toast').textContent), id('toast').textContent);
  click(id('maskDetail').querySelector('[data-close]'));

  /* ---------- 8. 未分组客户详情：无巡检对象勾选区、无分组表 ---------- */
  click(card('c0'));
  check('未分组客户不显示分组信息块', id('dUnits').style.display === 'none');
  check('未分组客户不显示巡检对象勾选区', id('dVisitUnitsWrap').style.display === 'none');
  click(id('maskDetail').querySelector('[data-close]'));

  /* ---------- 9. 客户表单：分组编辑 ---------- */
  click(id('btnAdd'));
  check('新增客户打开表单', id('maskCust').classList.contains('on'));
  check('分组编辑区存在', !!id('unitRows') && !!id('btnAddUnit'));
  click(id('btnAddUnit'));
  click(id('btnAddUnit'));
  let rowsEls = d.querySelectorAll('#unitRows .unit-row');
  check('点击添加分组出现两行', rowsEls.length === 2, rowsEls.length + '');
  rowsEls[0].querySelector('.u-name').value = '核心网络组';
  rowsEls[0].querySelector('.u-owner').value = '张三';
  rowsEls[1].querySelector('.u-note').value = '只填了备注没填名称';

  id('fName').value = '分组测试客户X';
  id('fLng').value = '115.700000';
  id('fLat').value = '37.800000';
  click(id('btnSaveCust'));
  check('分组名称为空时拦截保存', id('maskCust').classList.contains('on') &&
    /名称不能为空/.test(id('toast').textContent), id('toast').textContent);
  check('拦截时台账未新增客户', !store().customers.some(c => c.name === '分组测试客户X'));

  rowsEls = d.querySelectorAll('#unitRows .unit-row');
  rowsEls[1].querySelector('.u-name').value = '卡片业务组';
  click(id('btnSaveCust'));
  const nc = store().customers.filter(c => c.name === '分组测试客户X')[0];
  check('修正后保存成功', !!nc);
  check('分组随客户落库（2 个）', !!nc && Array.isArray(nc.units) && nc.units.length === 2,
    nc && JSON.stringify(nc.units));
  check('落库分组带 id 且负责人入档',
    !!nc && nc.units[0].name === '核心网络组' && nc.units[0].owner === '张三' &&
    nc.units[1].name === '卡片业务组' && !!nc.units[0].id && !!nc.units[1].id,
    nc && JSON.stringify(nc.units));

  /* 重名去重：两个同名分组只保留一个 */
  click(card(nc.id));
  click(id('btnEditCust'));
  click(id('btnAddUnit'));
  let rows2 = d.querySelectorAll('#unitRows .unit-row');
  rows2[0].querySelector('.u-name').value = '同名组';
  rows2[1].querySelector('.u-name').value = '同名组';
  click(id('btnSaveCust'));
  const nc2 = store().customers.filter(c => c.name === '分组测试客户X')[0];
  check('重名分组静默去重（同名组仅 1 个）',
    !!nc2 && nc2.units.filter(u => u.name === '同名组').length === 1,
    nc2 && JSON.stringify(nc2.units.map(u => u.name)));

  /* 删除分组：清空所有分组行后保存，units 同步清空，判定退回整体口径 */
  click(card(nc2.id));
  click(id('btnEditCust'));
  const delBtn = d.querySelector('#unitRows .unit-del');
  click(delBtn);
  click(id('btnSaveCust'));
  const nc3 = store().customers.filter(c => c.name === '分组测试客户X')[0];
  check('删除全部分组后保存（units 为空数组）', !!nc3 && Array.isArray(nc3.units) && nc3.units.length === 0,
    nc3 && JSON.stringify(nc3.units));
  check('清空分组后退回整体口径（未巡检 0/1）', badgeOf(nc3.id) === '未巡检 0/1', badgeOf(nc3.id));

  /* ---------- 汇总 ---------- */
  const fails = results.filter(r => r[0] === 'FAIL');
  console.log('\n===== 通过 ' + (results.length - fails.length) + ' / 共 ' + results.length + ' =====');
  results.forEach(r => { if (r[0] === 'FAIL') console.log('FAIL | ' + r[1] + ' | ' + (r[2] || '')); });
  if (errors.length) { console.log('JS 错误：'); errors.forEach(e => console.log('  ' + e)); }
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch(e => { console.error('测试执行异常：', e); process.exit(1); });
