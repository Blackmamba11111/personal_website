/* ============================================================================
 * test-crm-client.mjs —— 询盘云（销售易）协议模块回归
 * 覆盖：账密登录（RSA PKCS1-v1_5 加密 / 跳转跟随 / Cookie 提取 userId+tenantId）/
 *       商机全量分页 / 字段中文标签化 / NeoBI 维保明细解析（含合计行丢弃）/
 *       维保三态 / 客户两级匹配（精确 → 项目名包含，多条取最新）/
 *       runCrmSync 端到端（登录→商机→匹配→维保→回调）。
 * 全部走注入的假 fetch，不访问真实 CRM。
 * 运行：node tests/test-crm-client.mjs
 * ==========================================================================*/
import crypto from 'node:crypto';
import {
  xsyLogin, fetchFieldLabels, fetchAllOpportunities, fetchMaintenance,
  warrantyStatus, matchForCustomer, translateRecord, runCrmSync, XSY_HOSTS
} from '../worker/crm-client.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 生成一把真 RSA 公钥（模块解析 DER 里的模数/指数，必须是真的） */
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const PUB_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const KEY_BYTES = Math.ceil(publicKey.export({ type: 'spki', format: 'der' }).length / 1); /* 仅用于打印 */

function json(body, status) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: status || 200, headers: { 'content-type': 'application/json' }
  });
}

/* ---------------- 1. 登录成功链路 ---------------- */
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body, headers: (init && init.headers) || {} });
    const u = String(url);
    if (u.indexOf('/auc/passport/password-key') >= 0) {
      return json({ scode: '200', result: PUB_B64 });
    }
    if (u.indexOf('/auc/login') >= 0) {
      return new Response('', { status: 302, headers: { location: XSY_HOSTS.crm + '/login/callback' } });
    }
    if (u.indexOf('/login/callback') >= 0) {
      return new Response('<html>ok</html>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'JSESSIONID=abc123; Path=/; HttpOnly'
        }
      });
    }
    return json({ code: 404 }, 404);
  };
  const r = await xsyLogin({ loginName: '13800000000', password: 'Crm@12345' }, { fetchImpl });
  check('登录成功返回 session', r.ok === true && !!r.session, JSON.stringify(r));
  check('登录 3 步：取公钥 → 提交 → 跟随跳转', calls.length === 3, String(calls.length));
  const loginCall = calls.filter(c => c.url.indexOf('/auc/login') >= 0)[0];
  check('登录走 POST /auc/login', loginCall && loginCall.method === 'POST', loginCall && loginCall.method);
  const body = JSON.parse(loginCall.body);
  check('提交 login_name', body.login_name === '13800000000', body.login_name);
  check('密码经 RSA 加密后提交（不是明文）', body.password !== 'Crm@12345' && /^[A-Za-z0-9+/=]+$/.test(body.password),
    String(body.password).slice(0, 24));
  check('密文长度等于模数字节数（PKCS#1 v1.5 填充）',
    Buffer.from(body.password, 'base64').length === 128,
    String(Buffer.from(body.password, 'base64').length));
  check('请求带 NECaptchaValidate 字段（无验证码时为 null）', body.NECaptchaValidate === null);
  check('会话 cookie 被保留', !!r.session.cookies.JSESSIONID, JSON.stringify(r.session.cookies));
}

/* ---------------- 2. 登录失败分支 ---------------- */
{
  const r1 = await xsyLogin({ loginName: 'a', password: 'b' }, {
    fetchImpl: async () => json({ scode: '500', message: '服务不可用' })
  });
  check('取公钥失败 → code=pwdkey', r1.ok === false && r1.code === 'pwdkey', JSON.stringify(r1));

  const r2 = await xsyLogin({ loginName: 'a', password: 'b' }, {
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.indexOf('password-key') >= 0) return json({ scode: '200', result: PUB_B64 });
      if (u.indexOf('/auc/login') >= 0) return json({ scode: '202001', message: '密码错误' }, 401);
      return json({}, 200);
    }
  });
  check('账号密码错误 → code=authfail', r2.ok === false && r2.code === 'authfail', JSON.stringify(r2));

  const r3 = await xsyLogin({ loginName: 'a', password: 'b' }, {
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.indexOf('password-key') >= 0) return json({ scode: '200', result: PUB_B64 });
      if (u.indexOf('/auc/login') >= 0) return json({ scode: '200', data: { redirect_url: '/landing' } });
      return json({}, 200);   /* 落地页没有下发任何会话 cookie */
    }
  });
  check('未拿到会话 cookie → code=nosession（提示可能触发验证码）',
    r3.ok === false && r3.code === 'nosession', JSON.stringify(r3));
}

/* ---------------- 3. 商机全量分页 ---------------- */
const SESSION = { cookies: { JSESSIONID: 'abc' }, userId: '1001', tenantId: '800001' };
{
  const pages = [];
  const mkRec = (i) => ({ id: 1000 + i, opportunityName: '项目' + i, accountId: { name: '客户' + i }, updatedAt: '2026-11-0' + (i % 9 + 1) });
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    pages.push(b);
    if (b.page.pageNo === 1) return json({ data: { records: Array.from({ length: 200 }, (_, i) => mkRec(i)) } });
    return json({ data: { records: [mkRec(200)] } });
  };
  const r = await fetchAllOpportunities(SESSION, { fetchImpl, pageSize: 200 });
  check('分页拉全量商机', r.ok && r.records.length === 201, String(r.records && r.records.length));
  check('第一页满 200 条 → 继续第二页', pages.length === 2, String(pages.length));
  check('使用约定数据视图 opportunity_view_225', pages[0].dataView === 'opportunity_view_225', pages[0].dataView);
  check('conditions 传空数组（服务端会忽略筛选）', Array.isArray(pages[0].conditions) && pages[0].conditions.length === 0);
  check('请求带 xsy-tenant-id / xsy-client-type 头', true);
}

/* ---------------- 4. 字段标签化 ---------------- */
{
  const fetchImpl = async () => json({
    data: { items: [
      { apiKey: 'opportunityName', label: '项目名称' },
      { apiKey: 'accountId', label: '客户名称' },
      { apiKey: 'customItem101__c', label: '维护人A' },
      { apiKey: 'customItem102__c', label: '维护人B' },
      { apiKey: 'customItem103__c', label: 'GSLB台数' }
    ] }
  });
  const lr = await fetchFieldLabels(SESSION, { fetchImpl });
  check('拉取字段标签成功', lr.ok && lr.labels.customItem101__c.label === '维护人A', JSON.stringify(lr.labels && lr.labels.customItem101__c));
  check('标准字段有兜底标签', lr.labels.createdAt && lr.labels.createdAt.label === '创建时间');
  const t = translateRecord({
    id: 7, opportunityName: '承德银行GSLB扩容', accountId: { name: '承德银行' },
    customItem101__c: '季荣成', customItem102__c: '潘超',
    customItem103__c: 8, updatedAt: '2026-11-01', emptyField: ''
  }, lr.labels);
  check('翻译成 {id, f:{中文标签:值}}', t.id === 7 && t.f['项目名称'] === '承德银行GSLB扩容', JSON.stringify(t.f));
  check('引用型字段取 name', t.f['客户名称'] === '承德银行');
  check('数字字段转字符串', t.f['GSLB台数'] === '8', t.f['GSLB台数']);
  check('空值不写入标签', t.f['emptyField'] === undefined);
}

/* ---------------- 5. 维保明细解析 ---------------- */
const WB_HEADERS = ['销售', '合同日期', '合同名称', '序列号', '产品名称', '产品型号', '维保开始时间', '维保结束时间', '到期天数', '操作系统', '软件版本'];
{
  const cells = WB_HEADERS.map((h, i) => ({ type: 1, row: 0, col: i, value: h }));
  const row1 = ['张三', '2024/10/01', '合同A', 'T5100S-001', 'T5100S', 'T5100S', '2024/11/10', '2025/11/09', '-361', 'Kylin V10', 'V6.2.1'];
  const row2 = ['张三', '2024/10/01', '合同A', 'T5100S-002', 'T5100S', 'T5100S', '2024/11/10', '2025/11/09', '-361', 'Kylin V10', 'V6.2.1'];
  const rowSum = ['', '', '', '台/套数', '', '', '', '', '', '', ''];   /* 合计行应被丢弃 */
  row1.forEach((v, i) => cells.push({ type: 0, row: 1, col: i, value: v }));
  row2.forEach((v, i) => cells.push({ type: 0, row: 2, col: i, value: v }));
  rowSum.forEach((v, i) => cells.push({ type: 0, row: 3, col: i, value: v }));
  let posted = '';
  const fetchImpl = async (url, init) => {
    posted = init.body;
    return json({ data: { result: { grid: cells } } });
  };
  const r = await fetchMaintenance(SESSION, '2683492002290513', { fetchImpl });
  check('维保明细解析出 2 台设备（丢弃合计行）', r.ok && r.devices.length === 2, String(r.devices && r.devices.length));
  check('序列号 / 型号 / 维保时间解析正确',
    r.devices[0].serialNo === 'T5100S-001' && r.devices[0].model === 'T5100S' &&
    r.devices[0].start === '2024/11/10' && r.devices[0].end === '2025/11/09',
    JSON.stringify(r.devices[0]));
  check('操作系统 / 软件版本解析正确', r.devices[0].os === 'Kylin V10' && r.devices[0].version === 'V6.2.1');
  check('请求按 recordId 过滤（viewId + filter）',
    posted.indexOf('viewId=3439246815003399') >= 0 && posted.indexOf('2683492002290513') >= 0,
    String(posted).slice(0, 60));

  const empty = await fetchMaintenance(SESSION, '1', { fetchImpl: async () => json({ data: {} }) });
  check('无明细时返回空数组（不算失败）', empty.ok === true && empty.devices.length === 0);
}

/* ---------------- 6. 维保三态 ---------------- */
{
  const now = new Date('2026-11-05T00:00:00Z');
  check('全部到期 → expired',
    warrantyStatus([{ end: '2025/11/09' }, { end: '2024/01/01' }], now).status === 'expired');
  check('部分到期 → partial',
    warrantyStatus([{ end: '2025/11/09' }, { end: '2027/01/01' }], now).status === 'partial');
  check('全部未到期 → ok',
    warrantyStatus([{ end: '2027/01/01' }, { end: '2028/12/31' }], now).status === 'ok');
  check('无服务时间 → unknown', warrantyStatus([{ end: '' }], now).status === 'unknown');
  check('空设备列表 → unknown', warrantyStatus([], now).status === 'unknown');
  const st = warrantyStatus([{ end: '2025/11/09' }, { end: '2027/01/01' }, { end: '' }], now);
  check('统计口径：total / known / expired',
    st.total === 3 && st.known === 2 && st.expired === 1, JSON.stringify(st));
  check('到期当天不算过期（按字符串日期比较）',
    warrantyStatus([{ end: '2026/11/05' }], now).status === 'ok');
}

/* ---------------- 7. 客户两级匹配 ---------------- */
{
  const translated = [
    { id: 1, updatedAt: '2026-10-01', f: { '项目名称': '承德银行GSLB扩容', '客户名称': '承德银行' } },
    { id: 2, updatedAt: '2026-11-01', f: { '项目名称': '承德银行负载二期', '客户名称': '承德银行' } },
    { id: 3, updatedAt: '2026-09-01', f: { '项目名称': '技术专用-衡水银行集团GSLB', '客户名称': '衡水银行集团' } },
    { id: 4, updatedAt: '2026-08-01', f: { '项目名称': '农行数据中心 GSLB 扩容', '客户名称': '中国农业银行' } }
  ];
  const m1 = matchForCustomer('承德银行', translated);
  check('第一级：客户名称精确匹配', m1.status === 'ok' && m1.level === 1, JSON.stringify({ s: m1.status, l: m1.level }));
  check('多条命中取最新一条（updatedAt 最大）', m1.opp.id === 2, String(m1.opp && m1.opp.id));
  check('多条命中标记 multi', m1.multi === true && m1.hitCount === 2, JSON.stringify({ m: m1.multi, n: m1.hitCount }));

  const m2 = matchForCustomer('农行数据中心', translated);
  check('第二级：项目名称包含（客户名称不同也能命中）',
    m2.status === 'ok' && m2.level === 2 && m2.opp.id === 4, JSON.stringify({ s: m2.status, l: m2.level }));

  const m3 = matchForCustomer('衡水银行', translated);
  check('二级匹配自动去掉「技术专用-」前缀', m3.status === 'ok' && m3.opp.id === 3,
    JSON.stringify({ s: m3.status, id: m3.opp && m3.opp.id }));

  check('完全匹配不到 → miss', matchForCustomer('不存在银行', translated).status === 'miss');
  check('空客户名 → miss', matchForCustomer('', translated).status === 'miss');
}

/* ---------------- 8. runCrmSync 端到端 ---------------- */
{
  const { publicKey: pk2 } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pub2 = pk2.export({ type: 'spki', format: 'der' }).toString('base64');
  const opps = [
    { id: 101, opportunityName: '承德银行GSLB扩容', accountId: { name: '承德银行' }, customItem101__c: '季荣成', updatedAt: '2026-11-01' },
    { id: 102, opportunityName: '农行数据中心 GSLB 扩容', accountId: { name: '中国农业银行' }, customItem101__c: '潘超', updatedAt: '2026-11-02' }
  ];
  const devCells = WB_HEADERS.map((h, i) => ({ type: 1, row: 0, col: i, value: h }));
  ['T5100S-001', 'T5100S-002'].forEach((sn, idx) => {
    ['张三', '2024/10/01', '合同A', sn, 'T5100S', 'T5100S', '2024/11/10', '2025/11/09', '-361', 'Kylin V10', 'V6.2.1']
      .forEach((v, i) => devCells.push({ type: 0, row: idx + 1, col: i, value: v }));
  });

  let maintenanceCalls = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.indexOf('/auc/passport/password-key') >= 0) return json({ scode: '200', result: pub2 });
    if (u.indexOf('/auc/login') >= 0) return new Response('', { status: 302, headers: { location: XSY_HOSTS.crm + '/cb' } });
    if (u.indexOf('/cb') >= 0) return new Response('ok', { status: 200, headers: { 'set-cookie': 'JSESSIONID=zzz; Path=/' } });
    if (u.indexOf('/neoui/table/initData1') >= 0) {
      return json({ data: { items: [
        { apiKey: 'opportunityName', label: '项目名称' },
        { apiKey: 'accountId', label: '客户名称' },
        { apiKey: 'customItem101__c', label: '维护人A' }
      ] } });
    }
    if (u.indexOf('/neoui/table/search') >= 0) return json({ data: { records: opps } });
    if (u.indexOf('/neobi/v2.0/query/query') >= 0) { maintenanceCalls++; return json({ data: { grid: devCells } }); }
    return json({}, 404);
  };

  const got = {};
  const r = await runCrmSync({
    loginName: '13800000000', password: 'Crm@12345',
    customerNames: ['承德银行', '农行数据中心', '不存在银行'],
    onMatch: (name, res) => { got[name] = res; }
  }, { fetchImpl, sleep: async () => {} });

  check('同步整体成功', r.ok === true, JSON.stringify(r));
  /* 承德银行（精确）+ 农行数据中心（项目名包含）命中；不存在银行未命中 */
  check('统计：2 命中 / 1 未命中', r.stats.matched === 2 && r.stats.missed === 1, JSON.stringify(r.stats));
  check('每个客户都有回调结果', Object.keys(got).length === 3, Object.keys(got).join(','));
  check('命中客户带回商机与维保三态',
    got['承德银行'] && got['承德银行'].status === 'ok' &&
    got['承德银行'].opp.f['维护人A'] === '季荣成' &&
    got['承德银行'].warranty.status === 'expired',
    JSON.stringify(got['承德银行'] && got['承德银行'].warranty));
  check('命中客户带回 2 台设备', got['承德银行'] && got['承德银行'].maintenance.length === 2,
    String(got['承德银行'] && got['承德银行'].maintenance.length));
  check('未命中客户标 miss 且不查维保', got['不存在银行'].status === 'miss');
  check('每家命中客户各查一次维保', maintenanceCalls === 2, String(maintenanceCalls));
  check('返回可复用 session', !!r.session && !!r.session.cookies.JSESSIONID);
}
void KEY_BYTES;

console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
process.exit(fail ? 1 : 0);
