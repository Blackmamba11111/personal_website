/* ============================================================================
 * test-crm.js —— CRM（询盘云/销售易）台账关联专项回归
 * 覆盖：列表维保三态徽标 / 客户详情「客户现网信息 + 产品与技术信息」/
 *       项目技术负责人=维护人A / 「全部项目 · 我负责的项目」筛选（只认维护人A）/
 *       按用户 CRM 可见性（默认关闭时前后端都不下发）/
 *       CRM 管理页（配置保存走 PUT、连通性测试走 POST）/ 用户表单中文名与可见开关。
 * 运行：node tests/test-crm.js
 * ==========================================================================*/
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./test-helpers-server');
const { html, mkUser, installApiStub } = H;

const STORE = 'inspection_board_v1';
const TOKEN_KEY = 'inspection_board_token_v1';
const FIXED = new Date('2026-11-05T10:00:00+08:00').getTime();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------------- CRM 快照夹具（与 /api/crm/data 下发的结构一致） ---------------- */
const OPP_CD = {
  '项目名称': '技术专用-承德银行GSLB扩容', '客户名称': '承德银行', '客户级别': 'A 类',
  '一级行业': '金融', '二级行业': '银行', '战区': '华北战区', '所属部门': '金融事业部',
  '项目所有人': '李强', '维护人A': '季荣成', '维护人B': '潘超',
  '主要使用功能': 'GSLB 全局负载', '总采购数量': 8, 'GSLB台数': 8,
  '高可靠架构': '双活', '操作系统版本': 'Kylin V10', '现网软件版本': 'V6.2.1'
};
const MAINT_CD = [
  { serialNo: 'T5100S-001', product: 'T5100S', model: 'T5100S', start: '2024/11/10', end: '2025/11/09', os: 'Kylin V10', version: 'V6.2.1' },
  { serialNo: 'T5100S-002', product: 'T5100S', model: 'T5100S', start: '2024/11/10', end: '2025/11/09', os: 'Kylin V10', version: 'V6.2.1' },
  /* 配件行：不进清单、不计台数（2026-11-06 需求） */
  { serialNo: 'ACC-001', product: '配件-光模块', model: '--', start: '2024/11/10', end: '2025/11/09', os: '--', version: '--' }
];
const MATCHES = {
  '承德银行': {
    status: 'ok', level: 1, multi: false, updatedAt: '2026-11-05T09:00:00.000Z',
    opp: OPP_CD, maintenance: MAINT_CD,
    warranty: { status: 'expired', total: 2, known: 2, expired: 2 }
  },
  /* 维护人A = 潘超（当前登录用户的中文名），维保部分到期 */
  '衡水银行': {
    status: 'ok', level: 1, multi: false, updatedAt: '2026-11-05T09:00:00.000Z',
    opp: { '项目名称': '衡水银行负载均衡二期', '客户名称': '衡水银行', '维护人A': '潘超', '维护人B': '王五', 'GSLB台数': 2 },
    maintenance: [
      { serialNo: 'A-1', product: 'T5100S', model: 'T5100S', start: '2025/01/01', end: '2026/10/01', os: '', version: '' },
      { serialNo: 'A-2', product: 'T5100S', model: 'T5100S', start: '2025/06/01', end: '2027/06/01', os: '', version: '' }
    ],
    warranty: { status: 'partial', total: 2, known: 2, expired: 1 }
  },
  /* 维护人A = 潘超，未到期；按项目名匹配（level=2） */
  '农行数据中心': {
    status: 'ok', level: 2, multi: true, updatedAt: '2026-11-05T09:00:00.000Z',
    opp: { '项目名称': '农行数据中心 GSLB 扩容', '客户名称': '中国农业银行', '维护人A': '潘超', '维护人B': '张三', 'GSLB台数': 4 },
    maintenance: [
      { serialNo: 'B-1', product: 'T5100S', model: 'T5100S', start: '2025/09/01', end: '2027/09/01', os: '', version: '' }
    ],
    warranty: { status: 'ok', total: 1, known: 1, expired: 0 }
  },
  /* 未匹配：不应出现任何徽标 */
  '未匹配客户': { status: 'miss', level: 0, multi: false, updatedAt: '2026-11-05T09:00:00.000Z' }
};

const SEED = {
  regions: [{ id: 'r1', name: '河北片区', color: '#2563EB', provinces: ['河北'] }],
  customers: [
    { id: 'c1', name: '承德银行', regionId: 'r1', province: '河北', city: '承德', addr: '', lng: 117.96, lat: 40.95, freq: 'y4', contact: '张主管', phone: '0314-1', note: '', hasCoords: true },
    { id: 'c2', name: '衡水银行', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.67, lat: 37.74, freq: 'y4', contact: '李主管', phone: '0318-1', note: '', hasCoords: true },
    { id: 'c3', name: '农行数据中心', regionId: 'r1', province: '河北', city: '石家庄', addr: '', lng: 114.51, lat: 38.04, freq: 'y4', contact: '王主管', phone: '0311-1', note: '', hasCoords: true },
    { id: 'c4', name: '未匹配客户', regionId: 'r1', province: '河北', city: '保定', addr: '', lng: 115.46, lat: 38.87, freq: 'y4', contact: '赵主管', phone: '0312-1', note: '', hasCoords: true }
  ],
  visits: [
    { id: 'v1', customerId: 'c1', date: '2026-10-20', by: 'demo', note: '' }
  ]
};

/* ---------------- 建看板 DOM ---------------- */
function makeBoard(opts) {
  opts = opts || {};
  const users = [
    mkUser({ username: 'admin', name: '超级管理员', role: 'admin', password: 'admin888' }),
    mkUser({ username: 'demo', name: '河北片区', role: 'user', password: 'demo888' })
  ];
  users[1].nameCn = (opts.nameCn === undefined) ? '潘超' : opts.nameCn;
  users[1].crmVisible = !!opts.demoCrmVisible;
  const errors = [];
  let w, d;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:8899/inspection-dashboard.html',
    pretendToBeVisual: true,
    beforeParse(window) {
      const RealDate = window.Date;
      window.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [FIXED])); }
        static now() { return FIXED; }
      };
      window.localStorage.setItem('inspection_board_users_v1', JSON.stringify({ version: 1, users: users }));
      window.sessionStorage.setItem(TOKEN_KEY, 'test-token');
      window.localStorage.setItem(STORE + '::demo', JSON.stringify(SEED));
      installApiStub(window, {
        sessionUser: opts.sessionUser || 'demo',
        crmMatches: opts.crmMatches || {},
        servers: []
      });
    },
    virtualConsole: new VirtualConsole().on('jsdomError', e => {
      if (/Not implemented/.test(e.message)) return;
      errors.push(e.message);
    })
  });
  w = dom.window; d = w.document;
  return {
    dom, w, d, errors,
    id: x => d.getElementById(x),
    click: el => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })),
    card: cid => d.querySelector('.card-cust[data-id="' + cid + '"]'),
    cards: () => [...d.querySelectorAll('.card-cust')],
    waitReady: () => new Promise(r => {
      if (d.readyState === 'complete') return r();
      d.addEventListener('DOMContentLoaded', () => setTimeout(r, 40));
      setTimeout(r, 4000);
    }),
    tick: (n) => {
      let p = Promise.resolve();
      for (let i = 0; i < (n || 4); i++) p = p.then(() => new Promise(r => setTimeout(r, 0)));
      return p;
    }
  };
}

(async () => {
  /* ==================== A. 可见 CRM 的普通用户 ==================== */
  const A = makeBoard({ demoCrmVisible: true, crmMatches: MATCHES });
  await A.waitReady();
  await A.tick(6);

  check('A1 普通用户看不到「CRM 台账关联」入口', A.id('umCrm').style.display === 'none',
    'display=' + A.id('umCrm').style.display);

  /* 列表维保徽标（与「未巡检」徽标并列） */
  const badgeText = cid => {
    const c = A.card(cid);
    return c ? [...c.querySelectorAll('.badge')].map(x => x.textContent.trim()).join('|') : '(无卡片)';
  };
  check('A2 全部到期 → 列表显示「维保全部到期」', /维保全部到期/.test(badgeText('c1')), badgeText('c1'));
  check('A3 部分到期 → 列表显示「维保部分到期」', /维保部分到期/.test(badgeText('c2')), badgeText('c2'));
  check('A4 未到期 → 列表显示「维保未到期」', /维保未到期/.test(badgeText('c3')), badgeText('c3'));
  check('A5 未匹配客户不显示维保徽标', !/维保/.test(badgeText('c4')), badgeText('c4'));
  check('A6 维保徽标使用专用配色类', !!A.card('c1').querySelector('.badge.wb-expired') &&
    !!A.card('c2').querySelector('.badge.wb-partial') && !!A.card('c3').querySelector('.badge.wb-ok'));
  /* 顺序：名称 → 维保 → 巡检状态（巡检固定最右，2026-11-06 要求） */
  const badges1 = [...A.card('c1').querySelectorAll('.cc-row1 .badge')];
  check('A6b 维保徽标排在巡检状态左侧', badges1.length === 2 &&
    /wb-/.test(badges1[0].className) && /wb-/.test(badges1[1].className) === false,
    badges1.map(b => b.className).join(' | '));
  check('A6c 巡检状态固定在最右', /巡检|未巡检|已完成|部分/.test(badges1[badges1.length - 1].textContent),
    badges1[badges1.length - 1].textContent);

  /* 客户详情：客户现网信息 + 产品与技术信息 */
  A.click(A.card('c1'));
  await A.tick(2);
  check('A7 详情显示「客户现网信息」块', A.id('dCrmInfo').style.display === 'block',
    A.id('dCrmInfo').style.display);
  const base = A.id('dCrmBase').textContent;
  check('A8 现网信息含项目名称', /承德银行GSLB扩容/.test(base), base.slice(0, 80));
  check('A9 现网信息含客户级别与行业', /A 类/.test(base) && /金融/.test(base));
  check('A10 维护人A 标注为「项目技术负责人」', /项目技术负责人（维护人A）/.test(base) && /季荣成/.test(base));
  check('A11 硬件明细表按设备逐行展示', A.d.querySelectorAll('#dCrmHwTable tbody tr').length === 2,
    String(A.d.querySelectorAll('#dCrmHwTable tbody tr').length));
  check('A12 硬件行含序列号与服务时间', /T5100S-001/.test(A.id('dCrmHwTable').textContent) &&
    /2024\/11\/10/.test(A.id('dCrmHwTable').textContent));
  check('A12b 配件行不出现在硬件清单', !/配件-光模块/.test(A.id('dCrmHwTable').textContent) &&
    !/ACC-001/.test(A.id('dCrmHwTable').textContent), A.id('dCrmHwTable').textContent.slice(0, 120));
  check('A12c 台数不计配件', A.id('dCrmHwCount').textContent === '2', A.id('dCrmHwCount').textContent);
  check('A13 详情维保徽标为全部到期', /维保全部到期/.test(A.id('dCrmWarranty').textContent),
    A.id('dCrmWarranty').textContent);
  check('A14 详情显示「产品与技术信息」块', A.id('dCrmTech').style.display === 'block');
  const tech = A.id('dCrmTechBody').textContent;
  check('A15 技术信息含主要使用功能 / GSLB台数', /GSLB 全局负载/.test(tech) && /8 台/.test(tech), tech);
  check('A16 技术信息含高可靠架构 / 操作系统 / 软件版本',
    /双活/.test(tech) && /Kylin V10/.test(tech) && /V6\.2\.1/.test(tech));

  /* 我负责的项目：只看维护人A == 中文名 */
  check('A17 有 CRM 数据时显示项目切换条', A.id('mineChips').style.display !== 'none',
    A.id('mineChips').style.display);
  A.click(A.d.querySelector('#mineChips .chip[data-mine="mine"]'));
  await A.tick(2);
  const mineNames = A.cards().map(x => x.getAttribute('data-id')).sort().join(',');
  check('A18 「我负责的项目」按维护人A筛选（维护人B 相同不算）', mineNames === 'c2,c3', mineNames);
  check('A19 筛选后「承德银行」被排除（其维护人A为季荣成）', !mineNames.includes('c1'));
  A.click(A.d.querySelector('#mineChips .chip[data-mine="all"]'));
  await A.tick(2);
  check('A20 切回「全部项目」恢复 4 家', A.cards().length === 4, String(A.cards().length));

  /* ==================== B. 不可见 CRM 的普通用户（默认） ==================== */
  const B = makeBoard({ demoCrmVisible: false, crmMatches: MATCHES });
  await B.waitReady();
  await B.tick(6);
  check('B1 关闭可见后无任何维保徽标', !B.d.querySelector('.badge[class*="wb-"]'),
    B.d.querySelector('.badge[class*="wb-"]') ? '仍有徽标' : '');
  check('B2 关闭可见后隐藏项目切换条', B.id('mineChips').style.display === 'none',
    B.id('mineChips').style.display);
  B.click(B.card('c1'));
  await B.tick(2);
  check('B3 关闭可见后详情不显示现网信息', B.id('dCrmInfo').style.display === 'none',
    B.id('dCrmInfo').style.display);
  check('B4 关闭可见后详情不显示技术信息', B.id('dCrmTech').style.display === 'none');
  check('B5 登录后确实请求了 CRM 快照（服务端回空表）',
    B.w.__SRV__.calls.some(c => c.path === '/crm/data'),
    JSON.stringify(B.w.__SRV__.calls.filter(c => c.path.indexOf('crm') >= 0)));

  /* ==================== C. 超管：CRM 管理页 ==================== */
  const C = makeBoard({ sessionUser: 'admin', demoCrmVisible: true, crmMatches: MATCHES });
  await C.waitReady();
  await C.tick(6);
  check('C1 超管可见「CRM 台账关联」入口', C.id('umCrm').style.display === 'block',
    C.id('umCrm').style.display);
  C.click(C.id('umCrm'));
  await C.tick(3);
  check('C2 打开 CRM 管理页', C.id('crmView').classList.contains('on'));
  check('C3 打开时读取配置', C.w.__SRV__.calls.some(c => c.path === '/crm/config' && c.method === 'GET'));

  C.id('crmLogin').value = '13800000000';
  C.id('crmPwd').value = 'Crm@12345';
  C.id('crmInterval').value = '6';
  C.click(C.id('btnCrmSave'));
  await C.tick(4);
  const saveCall = C.w.__SRV__.calls.filter(c => c.path === '/crm/config').pop();
  check('C4 保存配置用 PUT（不是 GET）', saveCall && saveCall.method === 'PUT',
    saveCall ? saveCall.method : '(无请求)');
  check('C5 提交了账号 / 密码 / 间隔', saveCall && saveCall.body.loginName === '13800000000' &&
    saveCall.body.password === 'Crm@12345' && saveCall.body.intervalHours === 6,
    JSON.stringify(saveCall && saveCall.body));
  check('C6 配置已落库', C.w.__SRV__.crmConfig.loginName === '13800000000' &&
    C.w.__SRV__.crmConfig.intervalHours === 6, JSON.stringify(C.w.__SRV__.crmConfig));

  C.click(C.id('btnCrmTest'));
  await C.tick(4);
  const testCall = C.w.__SRV__.calls.filter(c => c.path === '/crm/test').pop();
  check('C7 测试连通性用 POST 并携带账密', testCall && testCall.method === 'POST' &&
    testCall.body.loginName === '13800000000', testCall ? testCall.method : '(无请求)');
  check('C8 连通结果回显到页面', /连通正常/.test(C.id('crmTestOut').textContent),
    C.id('crmTestOut').textContent);

  C.click(C.id('btnCrmSyncNow'));
  await C.tick(4);
  const syncCall = C.w.__SRV__.calls.filter(c => c.path === '/crm/sync').pop();
  check('C9 立即检索用 POST', syncCall && syncCall.method === 'POST', syncCall ? syncCall.method : '(无请求)');

  /* ==================== D. 用户管理表单：中文名 + CRM 可见 ==================== */
  C.click(C.id('umUsers'));
  await C.tick(4);
  C.click(C.id('btnNewUser'));
  await C.tick(3);
  check('D1 用户表单有「中文姓名」输入', !!C.id('uNameCn'));
  check('D2 用户表单有「CRM 可见」开关', !!C.id('uCrmVisible'));
  check('D3 CRM 可见默认关闭', C.id('uCrmVisible').checked === false);

  C.id('uUsername').value = 'crmuser1';
  C.id('uName').value = '河北片区';
  C.id('uNameCn').value = '潘超';
  C.id('uPwd').value = 'Crm@12345';
  C.id('uCrmVisible').checked = true;
  C.click(C.id('btnSaveUser'));
  await C.tick(6);
  const nu = C.w.__SRV__.users.filter(u => u.username === 'crmuser1')[0];
  check('D4 新建用户保存中文名', nu && nu.nameCn === '潘超', nu ? JSON.stringify(nu.nameCn) : '(未创建)');
  check('D5 新建用户保存 CRM 可见开关', nu && nu.crmVisible === true, nu ? String(nu.crmVisible) : '(未创建)');

  /* 默认不勾选 → 服务端存 false */
  C.click(C.id('btnNewUser'));
  await C.tick(3);
  C.id('uUsername').value = 'crmuser2';
  C.id('uName').value = '山西片区';
  C.id('uPwd').value = 'Crm@12345';
  C.click(C.id('btnSaveUser'));
  await C.tick(6);
  const nu2 = C.w.__SRV__.users.filter(u => u.username === 'crmuser2')[0];
  check('D6 未勾选时 CRM 可见默认为关', nu2 && nu2.crmVisible === false,
    nu2 ? String(nu2.crmVisible) : '(未创建)');
  check('D7 中文名留空允许保存', nu2 && nu2.nameCn === '', nu2 ? JSON.stringify(nu2.nameCn) : '(未创建)');
  /* 表单里直接列出 CRM 出现过的维护人姓名，避免手填错字导致「我负责的项目」永远空 */
  C.click(C.id('btnNewUser'));
  await C.tick(3);
  check('D8 中文名下方列出 CRM 可选姓名', /季荣成/.test(C.id('uNameCnTip').textContent),
    C.id('uNameCnTip').textContent.slice(0, 80));
  check('D9 单个用户开关文案不再写「默认关闭」', C.d.body.textContent.indexOf('可见 CRM 现网信息（默认关闭）') < 0,
    '仍存在「（默认关闭）」后缀');

  /* ==================== E. 账号没填中文名 → 「我负责的项目」给出明确提示 ==================== */
  const E = makeBoard({ demoCrmVisible: true, crmMatches: MATCHES, nameCn: '' });
  await E.waitReady();
  await E.tick(6);
  E.click(E.id('mineChips').querySelector('[data-mine="mine"]'));
  await E.tick(4);
  const emptyTxt = E.id('custList').textContent;
  check('E1 未设中文名时列表为空', E.cards().length === 0, String(E.cards().length));
  check('E2 空结果提示「未设置中文姓名」而不是笼统的无结果', /未设置「中文姓名」/.test(emptyTxt), emptyTxt.slice(0, 100));

  /* ==================== G. 多项目聚合（同一客户命中多条商机） ==================== */
  /* 聚合后维护字段：设备带 projectName（保留记录所属项目）与 projectNames（全部所属项目） */
  const AGG_DEV = (sn, end, proj, all) => ({
    serialNo: sn, product: 'T5100S', model: 'T5100S', start: '2024/11/10', end,
    os: 'Kylin V10', version: 'V6.2.1', projectName: proj, projectNames: all
  });
  const P1 = '技术专用-承德银行GSLB一期';
  const P2 = '技术专用-承德银行GSLB二期';
  const P3 = '技术专用-承德银行灾备三期';        /* 该项目无维保记录 */
  const AGG_MATCHES = Object.assign({}, MATCHES, {
    '承德银行': {
      status: 'ok', level: 1, multi: true, hitCount: 3, updatedAt: '2026-11-05T09:00:00.000Z',
      opp: OPP_CD,
      maintenance: [AGG_DEV('SN-A', '2024/01/01', P1, [P1]), AGG_DEV('SN-B', '2030/12/31', P2, [P1, P2]), AGG_DEV('SN-C', '2024/05/05', P2, [P2])],
      projects: [
        { id: 101, name: P1, updatedAt: '2026-11-02', devices: [{ serialNo: 'SN-A' }, { serialNo: 'SN-B' }], warranty: { status: 'partial', total: 2, known: 2, expired: 1 } },
        { id: 102, name: P2, updatedAt: '2026-10-01', devices: [{ serialNo: 'SN-B' }, { serialNo: 'SN-C' }], warranty: { status: 'partial', total: 2, known: 2, expired: 1 } },
        { id: 103, name: P3, updatedAt: '2026-09-01', devices: [], warranty: { status: 'unknown', total: 0, known: 0, expired: 0 } }
      ],
      warranty: { status: 'partial', total: 3, known: 3, expired: 2 }
    }
  });
  const G = makeBoard({ demoCrmVisible: true, crmMatches: AGG_MATCHES });
  await G.waitReady();
  await G.tick(6);
  check('G1 聚合后列表维保徽标按合并清单显示「部分到期」',
    /维保部分到期/.test([...G.card('c1').querySelectorAll('.badge')].map(x => x.textContent).join('|')),
    [...G.card('c1').querySelectorAll('.badge')].map(x => x.textContent).join('|'));
  G.click(G.card('c1'));
  await G.tick(2);
  const src = G.id('dCrmSrc').textContent;
  check('G2 来源行标注命中项目数与「有维保记录」个数',
    /命中 3 个项目/.test(src) && /2 个有维保记录/.test(src), src);
  const wbTxt = G.id('dCrmWarranty').textContent;
  const tagTxt = [...G.d.querySelectorAll('#dCrmWarranty .tag')].map(x => x.textContent).join('|');
  check('G2b 项目级标签只列有维保记录的项目',
    tagTxt.indexOf(P1) >= 0 && tagTxt.indexOf(P2) >= 0 && tagTxt.indexOf(P3) < 0, tagTxt);
  check('G2c 无维保记录的项目合并成一行小字',
    /无维保记录 1 个项目/.test(wbTxt) && new RegExp(P3).test(wbTxt), wbTxt.slice(-120));
  check('G3 硬件清单表头新增「所属项目」列', /所属项目/.test(G.id('dCrmHwTable').textContent),
    G.id('dCrmHwTable').querySelector('thead').textContent);
  check('G4 台数按序列号去重后为 3 台', G.id('dCrmHwCount').textContent === '3', G.id('dCrmHwCount').textContent);
  const rowsG = [...G.d.querySelectorAll('#dCrmHwTable tbody tr')];
  const rowB = rowsG.filter(tr => /SN-B/.test(tr.textContent))[0];
  check('G5 跨项目设备行同时标出两个项目', !!rowB && rowB.textContent.indexOf(P1) >= 0 && rowB.textContent.indexOf(P2) >= 0,
    rowB ? rowB.textContent : '(无 SN-B 行)');
  check('G6 去重说明与项目级三态可见',
    /按序列号去重/.test(G.id('dCrmHwNote').textContent) && /按项目：/.test(G.id('dCrmWarranty').textContent),
    G.id('dCrmHwNote').textContent + ' | ' + G.id('dCrmWarranty').textContent.slice(0, 80));
  /* 兼容旧快照：multi=true 但没有 projects 字段 → 退化为单项目展示，不出现「所属项目」列 */
  G.click(G.card('c3'));
  await G.tick(2);
  check('G7 旧快照（无 projects）退化为单项目展示',
    !/所属项目/.test(G.id('dCrmHwTable').querySelector('thead').textContent) &&
    /农行数据中心 GSLB 扩容/.test(G.id('dCrmSrc').textContent),
    G.id('dCrmSrc').textContent);

  check('F1 运行期无 JS 异常', A.errors.length === 0 && B.errors.length === 0 && C.errors.length === 0 &&
    E.errors.length === 0 && G.errors.length === 0,
    A.errors.concat(B.errors, C.errors, E.errors, G.errors).slice(0, 3).join(' / '));

  console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e && e.stack || e);
  console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
  process.exit(1);
});
