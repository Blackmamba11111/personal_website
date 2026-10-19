/* 月度考核（一年12次＝每月1次）专项回归测试 */
const { JSDOM, VirtualConsole } = require('jsdom');
const { html, mkUser } = require('./test-helpers-server');
const STORE = 'inspection_board_v1';
const PREF = 'inspection_board_pref_v1';

const USERS = { version: 1, users: [
  mkUser({ username: 'admin', name: '超级管理员', role: 'admin', password: 'admin888' }),
  mkUser({ username: 'demo',  name: '演示用户',   role: 'user',  password: 'demo888' })
] };

const errors = [];
const results = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }

/* 固定场景：今天 = 2026-10-12（Q4，已到月份仅 10 月） */
const SEED = {
  regions: [{ id: 'r1', name: '测试区', color: '#2563EB', provinces: ['河北'] }],
  customers: [
    { id: 'c1', name: '月度-A-已做本月', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.67, lat: 37.73, freq: 'y12', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'c2', name: '月度-B-本月未做', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.68, lat: 37.74, freq: 'y12', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'c3', name: '月度-C-缺9月',   regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.69, lat: 37.75, freq: 'y12', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'c4', name: '月度-D-单月三次', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.70, lat: 37.76, freq: 'y12', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'c5', name: '季度-E-一年4次', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.71, lat: 37.77, freq: 'y4', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'c6', name: '季度-F-每季1次', regionId: 'r1', province: '河北', city: '衡水', addr: '', lng: 115.72, lat: 37.78, freq: 'quarter', contact: '', phone: '', note: '', hasCoords: true }
  ],
  visits: [
    { id: 'v1', customerId: 'c1', date: '2026-10-05', by: '', note: '' },
    { id: 'v2', customerId: 'c3', date: '2026-07-10', by: '', note: '' },
    { id: 'v3', customerId: 'c3', date: '2026-08-11', by: '', note: '' },
    { id: 'v4', customerId: 'c4', date: '2026-07-02', by: '', note: '' },
    { id: 'v5', customerId: 'c4', date: '2026-07-15', by: '', note: '' },
    { id: 'v6', customerId: 'c4', date: '2026-07-28', by: '', note: '' },
    { id: 'v7', customerId: 'c5', date: '2026-08-01', by: '', note: '' },
    { id: 'v8', customerId: 'c6', date: '2026-09-20', by: '', note: '' }
  ]
};

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://127.0.0.1:8899/inspection-dashboard.html',
  pretendToBeVisual: true,
  beforeParse(window) {
    /* V2：以普通用户 demo 身份登录，台账与偏好都按账号隔离 */
    window.localStorage.setItem('inspection_board_users_v1', JSON.stringify(USERS));
    /* 台账已迁移到服务端：用令牌替代旧会话键，并注入内存版服务端 */
    window.localStorage.setItem('inspection_board_token_v1', 'test-token');
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
const card = cid => d.querySelector('#custList .card-cust[data-id="' + cid + '"]');
const cells = el => [...el.querySelectorAll('.mcell')].map(x => x.className.replace('mcell', '').trim());

setTimeout(() => {
  // ---------- 默认季度 = 2026Q4（今天 2026-10-12，仅 10 月已到） ----------
  check('默认季度为 2026Q4', id('quarterSel').value === '2026Q4', id('quarterSel').value);

  const c1 = card('c1'), c2 = card('c2');
  check('C1 本月已巡检 → 状态 ok', c1.classList.contains('s-ok'), c1.className);
  check('C1 徽标为「月度达标 1/1」', /月度达标 1\/1/.test(c1.textContent), c1.querySelector('.badge').textContent);
  check('C1 月度条 3 格（done/todo/todo）', JSON.stringify(cells(c1)) === JSON.stringify(['done', 'todo', 'todo']), cells(c1).join('|'));

  check('C2 本月未巡检 → 状态 miss', c2.classList.contains('s-miss'), c2.className);
  check('C2 徽标为「未巡检 0/1 月」', /未巡检 0\/1 月/.test(c2.textContent), c2.querySelector('.badge').textContent);
  check('C2 月度条 10月 标记 lack', cells(c2)[0] === 'lack', cells(c2).join('|'));

  check('未到月份不计入缺项：C1 未被判为部分完成', !c1.classList.contains('s-part'));

  // 非按月客户不应出现月度条
  check('每季度1次客户无月度条', card('c6').querySelector('.mstrip') === null);
  check('一年4次客户无月度条', card('c5').querySelector('.mstrip') === null);

  // ---------- 切换到 2026Q3（7/8/9 月全部已到） ----------
  const sel = id('quarterSel');
  sel.value = '2026Q3';
  fire(sel, 'change');
  check('季度切换为 2026Q3', id('quarterSel').value === '2026Q3');

  const c3 = card('c3'), c4 = card('c4');
  check('C3（7、8 月已做，9 月缺）→ part', c3.classList.contains('s-part'), c3.className);
  check('C3 徽标为「缺 1 个月」', /缺 1 个月/.test(c3.textContent), c3.querySelector('.badge').textContent);
  check('C3 月度条 done/done/lack', JSON.stringify(cells(c3)) === JSON.stringify(['done', 'done', 'lack']), cells(c3).join('|'));

  check('C4（3 次全在 7 月）→ part，不因次数达标而判 ok', c4.classList.contains('s-part'), c4.className);
  check('C4 徽标为「缺 2 个月」', /缺 2 个月/.test(c4.textContent), c4.querySelector('.badge').textContent);
  check('C4 月度条 仅 7 月 done', JSON.stringify(cells(c4)) === JSON.stringify(['done', 'lack', 'lack']), cells(c4).join('|'));

  check('C5（一年4次，8月1次）→ ok，按季度口径', card('c5').classList.contains('s-ok'), card('c5').className);
  check('C6（每季度1次，9月1次）→ ok', card('c6').classList.contains('s-ok'), card('c6').className);

  // 通过界面登记补做：验证「补做后状态自动转 ok」
  click(card('c3'));
  id('dVisitDate').value = '2026-09-03';
  click(id('btnAddVisit'));
  check('C3 补做 9 月后 → 状态 ok', card('c3').classList.contains('s-ok'), card('c3').className);
  check('C3 补做后徽标「月度达标 3/3」', /月度达标 3\/3/.test(card('c3').textContent),
    card('c3').querySelector('.badge').textContent);
  check('C3 补做后月度条全绿', JSON.stringify(cells(card('c3'))) === JSON.stringify(['done', 'done', 'done']),
    cells(card('c3')).join('|'));

  // ---------- 详情弹窗的月度区 ----------
  click(card('c4'));
  check('详情弹窗打开', id('maskDetail').classList.contains('on'));
  check('按月客户显示月度区', id('dMonths').style.display === 'block', id('dMonths').style.display);
  check('月度区含 3 个格子', id('dMonths').querySelectorAll('.mcell').length === 3,
    id('dMonths').querySelectorAll('.mcell').length + ' 格');
  check('月度区提示含「待补 8月、9月」', /待补\s*8月、9月/.test(id('dMonths').textContent), id('dMonths').textContent);
  check('月度区含「已到 3 个月」', /已到\s*3\s*个月/.test(id('dMonths').textContent));
  click(d.querySelector('#maskDetail [data-close="maskDetail"]'));

  click(card('c5'));
  check('非按月客户隐藏月度区', id('dMonths').style.display === 'none', id('dMonths').style.display);
  check('非按月客户月度区无残留内容', id('dMonths').innerHTML === '');
  click(d.querySelector('#maskDetail [data-close="maskDetail"]'));

  // ---------- 提醒窗口 ----------
  click(id('btnRemind'));
  check('提醒窗口打开', id('maskRemind').classList.contains('on'));
  const rmTxt = id('rmList').textContent;
  check('提醒列表出现 C4 且标注待补月份', /月度-D-单月三次/.test(rmTxt) && /待补\s*8月、9月/.test(rmTxt));
  check('提醒列表标签为「缺 2 个月」', /缺 2 个月/.test(rmTxt));
  const rmRows = [...d.querySelectorAll('#rmList .r-row')].length;
  check('提醒列表仅含未达标客户（Q3 应为 3 行：C1/C2 未巡检 + C4 缺月）', rmRows === 3, rmRows + ' 行');
  check('提醒列表不含已达标的 C3', !/月度-C-缺9月/.test(rmTxt));
  click(d.querySelector('#maskRemind [data-close="maskRemind"]'));

  // ---------- 导出报表含月度列 ----------
  click(id('btnExport'));
  const csv = id('exBox').value;
  check('报表表头含「本季度达标月份」', /本季度达标月份/.test(csv));
  check('报表表头含「考核口径」', /考核口径/.test(csv));
  check('报表中按月客户口径标注正确', /按月（每月1次）/.test(csv));
  check('报表中待补月份已写出', /待补 8月、9月/.test(csv), (csv.split('\n').find(l => /月度-D/.test(l)) || '').trim());

  // ---------- 频率选项文案 ----------
  click(id('btnAdd'));
  const freqHtml = id('freqOpts').textContent;
  check('频率选项说明「按月考核」', /按月考核/.test(freqHtml), freqHtml.replace(/\s+/g, ' ').trim());
  check('频率选项说明「每月 1 次」', /每月 1 次/.test(freqHtml));
  check('频率选项说明「季度 3 次」', /季度 3 次/.test(freqHtml));

  console.log('\n========== 月度考核测试 ==========');
  let pass = 0, fail = 0;
  results.forEach(([s, l, e]) => {
    if (s === 'PASS') pass++; else fail++;
    console.log(s.padEnd(5), l, e && s === 'FAIL' ? '=> ' + e : '');
  });
  console.log('--------------------------------');
  console.log('通过 ' + pass + ' / 共 ' + results.length + '，失败 ' + fail);
  if (errors.length) {
    console.log('运行期错误:');
    errors.forEach(x => console.log('  ' + x));
  } else {
    console.log('运行期错误: 无');
  }
  process.exit(fail || errors.length ? 1 : 0);
}, 700);
