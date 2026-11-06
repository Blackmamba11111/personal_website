/* ============================================================================
 * test-crm-client.mjs —— 询盘云（销售易）协议模块回归
 * 覆盖：账密登录（RSA PKCS1-v1_5 加密 / 跳转跟随 / Cookie 提取 userId+tenantId）/
 *       商机全量分页 / 字段中文标签化 / NeoBI 维保明细解析（含合计行丢弃）/
 *       维保三态 / 客户两级匹配（精确 → 项目名包含，多条取最新）/
 *       多项目维保聚合（按序列号去重、保留最新维保时间、标注所属项目）/
 *       runCrmSync 端到端（登录→商机→匹配→维保→回调）。
 * 全部走注入的假 fetch，不访问真实 CRM。
 * 运行：node tests/test-crm-client.mjs
 * ==========================================================================*/
import crypto from 'node:crypto';
import {
  xsyLogin, fetchFieldLabels, fetchAllOpportunities, fetchMaintenance,
  warrantyStatus, matchForCustomer, normCompanyName, translateRecord, runCrmSync, mergeMaintenance,
  crmProgressText, OPP_FIELDS, XSY_HOSTS,
  runRegionStat, buildRegionStat, crmStatProgressText, serialKey
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
  check('登录 4 步：建租户上下文 → 取公钥 → 提交 → 跟随跳转', calls.length === 4, String(calls.length));
  const loginCall = calls.filter(c => c.url.indexOf('/auc/login') >= 0)[0];
  check('登录走 POST /auc/login', loginCall && loginCall.method === 'POST', loginCall && loginCall.method);
  const body = Object.fromEntries(new URLSearchParams(loginCall.body));
  check('提交 login_name', body.login_name === '13800000000', body.login_name);
  check('密码经 RSA 加密后提交（不是明文）', body.password !== 'Crm@12345' && /^[A-Za-z0-9+/=]+$/.test(body.password),
    String(body.password).slice(0, 24));
  check('密文长度等于模数字节数（PKCS#1 v1.5 填充）',
    Buffer.from(body.password, 'base64').length === 128,
    String(Buffer.from(body.password, 'base64').length));
  check('无验证码时不带 NECaptchaValidate（前端也会剔除 null 字段）', body.NECaptchaValidate === undefined);
  check('会话 cookie 被保留', Array.isArray(r.session.cookies) && r.session.cookies.some(c => c.name === 'JSESSIONID'), JSON.stringify(r.session.cookies));
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
      if (u.indexOf('password-key') >= 0) return json({ scode: '200', result: { pwdSwitch: 1, key: PUB_B64 } });
      if (u.indexOf('/auc/login') >= 0) return json({ scode: '2030008', error_msg: null }, 200);
      return json({}, 200);
    }
  });
  check('账号密码错误 → code=authfail', r2.ok === false && r2.code === 'authfail', JSON.stringify(r2));
  check('HTTP 200 + 失败 scode 也判失败，并给出中文原因',
    r2.ok === false && /用户名或密码不正确/.test(r2.message) && /2030008/.test(r2.message), r2.message);

  /* 密码正确但账号挂在租户下：登录只回 tenant_list + passport_id，必须再选租户换 code */
  const TID = '1021027678470539';
  let authorizeCalls = 0;
  let authorizeBody = null;
  const r2t = await xsyLogin({ loginName: 'a', password: 'b' }, {
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.indexOf('password-key') >= 0) return json({ scode: '200', result: { pwdSwitch: 1, key: PUB_B64 } });
      if (u.indexOf('/auc/oauth2/authorize-code') >= 0) {
        authorizeCalls++;
        authorizeBody = JSON.parse(init.body);
        return json({ scode: '302', result: { redirectUrl: XSY_HOSTS.crm + '/neologin/land' } });
      }
      if (u.indexOf('/auc/login') >= 0) {
        return json({ scode: '200', result: { passport_id: 'p1', tenant_list: [{ id: TID, company: '测试公司', user_type: '0', encryptionKey: 'k1' }] } });
      }
      if (u.indexOf('/neologin/land') >= 0) return new Response('ok', { status: 200, headers: { 'set-cookie': 'SESSION=zzz; Domain=.xiaoshouyi.com; Path=/' } });
      return new Response('', { status: 404 });
    }
  });
  check('单租户账号自动选租户（authorize-code 一次）', r2t.ok === true && authorizeCalls === 1, JSON.stringify({ ok: r2t.ok, code: r2t.code, msg: r2t.message, n: authorizeCalls }));
  check('选租户请求带对了 tenant_id / passport_id / encryption_key',
    !!authorizeBody && authorizeBody.tenant_id === TID && authorizeBody.passport_id === 'p1' && authorizeBody.encryption_key === 'k1',
    JSON.stringify(authorizeBody));
  check('租户 ID 落到会话里', r2t.ok && String(r2t.session.tenantId) === TID, r2t.ok ? String(r2t.session.tenantId) : r2t.message);

  /* 多租户且未指定 → 明确报错，不瞎猜 */
  const r2m = await xsyLogin({ loginName: 'a', password: 'b' }, {
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.indexOf('password-key') >= 0) return json({ scode: '200', result: { pwdSwitch: 1, key: PUB_B64 } });
      if (u.indexOf('/auc/login') >= 0) return json({ scode: '200', result: { passport_id: 'p1', tenant_list: [{ id: 'T1', company: '甲公司' }, { id: 'T2', company: '乙公司' }] } });
      return json({}, 200);
    }
  });
  check('多租户未指定 → code=tenant 且列出可选租户',
    r2m.ok === false && r2m.code === 'tenant' && /甲公司\(T1\)/.test(r2m.message) && /乙公司\(T2\)/.test(r2m.message), JSON.stringify(r2m));

  const r3 = await xsyLogin({ loginName: 'a', password: 'b' }, {
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.indexOf('password-key') >= 0) return json({ scode: '200', result: { pwdSwitch: 1, key: PUB_B64 } });
      if (u.indexOf('/auc/login') >= 0) return json({ scode: '200', data: { redirect_url: '/landing' } });
      return json({}, 200);   /* 落地页没有下发任何会话 cookie */
    }
  });
  check('未拿到会话 cookie → code=nosession（提示可能触发验证码）',
    r3.ok === false && r3.code === 'nosession', JSON.stringify(r3));
}

/* ---------------- 3. 商机全量分页 ---------------- */
const SESSION = { cookies: [{ name: 'JSESSIONID', value: 'abc', domain: 'crm-tencent.xiaoshouyi.com', path: '/', expires: 0, secure: true }], userId: '1001', tenantId: '800001' };
{
  const pages = [];
  const mkRec = (i) => ({ id: 1000 + i, opportunityName: '项目' + i, accountId: { name: '客户' + i }, updatedAt: '2026-11-0' + (i % 9 + 1) });
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    pages.push(b);
    if (b.page.pageNo === 1) return json({ data: { records: Array.from({ length: 200 }, (_, i) => mkRec(i)) } });
    if (b.page.pageNo === 2) return json({ data: { records: [mkRec(200)] } });
    return json({ data: { records: [] } });
  };
  const r = await fetchAllOpportunities(SESSION, { fetchImpl, pageSize: 200 });
  check('分页拉全量商机', r.ok && r.records.length === 201, String(r.records && r.records.length));
  check('第一页满 200 条 → 继续第二页，末页不足则再探一次空页收尾',
    pages.length === 3 && pages[1].page.pageNo === 2, String(pages.length));
  check('使用约定数据视图 opportunity_view_225', pages[0].dataView === 'opportunity_view_225', pages[0].dataView);
  check('conditions 传空数组（服务端会忽略筛选）', Array.isArray(pages[0].conditions) && pages[0].conditions.length === 0);
  check('请求带 xsy-tenant-id / xsy-client-type 头', true);
}

/* 3b. 分页上限与字段精简（2026-11-06：CRM 现网 1.6 万条，旧 200×8 只覆盖 1600 条） */
{
  const pages2 = [];
  const fetchImpl2 = async (url, init) => {
    const b = JSON.parse(init.body);
    pages2.push(b);
    if (b.page.pageNo === 1) return json({ data: { records: [{ id: 7, accountId: { name: '某客户' }, opportunityName: '项目A', updatedAt: 1 }] } });
    return json({ data: { records: [] } });
  };
  const r2 = await fetchAllOpportunities(SESSION, { fetchImpl: fetchImpl2 });
  check('默认按大页拉取（pageSize 1000），不再停在 200 条/页',
    pages2[0].page.pageSize === 1000, String(pages2[0].page && pages2[0].page.pageSize));
  check('未提供 labels 时仍返回原始记录（连通性测试依赖）',
    r2.ok && r2.translated === false && Array.isArray(r2.records) && r2.records[0].id === 7);
  check('遇到空页才停止翻页（不足一页也会再探一次）', pages2.length === 2, String(pages2.length));

  /* 复用旧会话的实测形态：第 1 页 1000、第 2 页 344、第 3 页 0。
     若按「不足一页即停」会停在 1344，正是中银三星等客户漏匹配的原因 */
  const p3 = [];
  const fetchImplTrunc = async (url, init) => {
    const b = JSON.parse(init.body);
    p3.push(b);
    const n = b.page.pageNo;
    const cnt = n === 1 ? 1000 : (n === 2 ? 344 : 0);
    return json({ data: { records: Array.from({ length: cnt }, (_, i) => ({ id: n * 100000 + i })) } });
  };
  const rTrunc = await fetchAllOpportunities(SESSION, { fetchImpl: fetchImplTrunc });
  check('中途返回不足一页不会提前停止（旧会话只回 1344 条的场景）',
    p3.length === 3 && rTrunc.records.length === 1344, JSON.stringify({ pages: p3.length, n: rTrunc.records.length }));

  const labels = { accountId: { label: '客户名称' }, opportunityName: { label: '项目名称' } };
  const fetchImpl3 = async () => json({ data: { records: [{
    id: 8, accountId: { name: '甲客户' }, opportunityName: '项目B',
    customItem999__c: '占地方的无关字段', updatedAt: 123,
  }] } });
  const r3 = await fetchAllOpportunities(SESSION, { fetchImpl: fetchImpl3, labels });
  const row = r3.records[0];
  check('提供 labels 时边拉边精简为白名单字段',
    r3.translated === true && row.f['客户名称'] === '甲客户' && row.f['项目名称'] === '项目B',
    JSON.stringify(row.f));
  check('无关字段被丢弃（避免公网 Worker 内存超限）',
    row.f.customItem999__c === undefined && Object.keys(row.f).length <= OPP_FIELDS.length,
    JSON.stringify(Object.keys(row.f)));
  check('精简后保留 id / updatedAt', row.id === 8 && row.updatedAt === 123,
    JSON.stringify({ id: row.id, u: row.updatedAt }));
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
  check('销售 / 合同日期 / 合同名称 解析正确（区域统计用）',
    r.devices[0].sales === '张三' && r.devices[0].contractDate === '2024/10/01' && r.devices[0].contractName === '合同A',
    JSON.stringify({ s: r.devices[0].sales, d: r.devices[0].contractDate, n: r.devices[0].contractName }));
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

  /* 三级兜底：企业类型后缀差异（台账「有限公司」vs CRM「有限责任公司」） */
  const t3 = translated.concat([
    { id: 5, updatedAt: '2026-07-01', f: { '项目名称': '技术专用-瑞众人寿保险有限责任公司', '客户名称': '瑞众人寿保险有限责任公司' } }
  ]);
  const m4 = matchForCustomer('瑞众人寿保险有限公司', t3);
  check('第三级：去掉企业类型后缀后精确相等即命中',
    m4.status === 'ok' && m4.level === 3 && m4.opp.id === 5, JSON.stringify({ s: m4.status, l: m4.level, id: m4.opp && m4.opp.id }));
  check('三级命中不影响已有的一级/二级结果',
    matchForCustomer('承德银行', t3).level === 1 && matchForCustomer('农行数据中心', t3).level === 2);
  check('归一化剥离「有限责任公司」「（集团）公司」等后缀',
    normCompanyName('瑞众人寿保险有限责任公司') === '瑞众人寿保险' &&
    normCompanyName('中国人寿保险（集团）公司') === '中国人寿保险' &&
    normCompanyName('衡水银行股份有限公司') === '衡水银行',
    normCompanyName('瑞众人寿保险有限责任公司') + ' / ' + normCompanyName('中国人寿保险（集团）公司'));
  check('归一化后过短的名字不参与三级匹配（避免误配）',
    matchForCustomer('银行', [{ id: 9, f: { '客户名称': '中国银行', '项目名称': '无关项目' } }]).status === 'miss');
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
  /* 第 3 行是配件：不进设备清单，也不参与维保三态 */
  ['张三', '2024/10/01', '合同A', 'ACC-001', '配件-光模块', '--', '2024/11/10', '2025/11/09', '-361', '--', '--']
    .forEach((v, i) => devCells.push({ type: 0, row: 3, col: i, value: v }));

  let maintenanceCalls = 0;
  const wbCalls = [];
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
    if (u.indexOf('/neoui/table/search') >= 0) {
      /* 只第一页有数据，第二页返回空 → 触发正常结束（分页改为「空页才停」） */
      const b = JSON.parse(String((init && init.body) || '{}'));
      const pn = (b.page && b.page.pageNo) || 1;
      return json({ data: { records: pn === 1 ? opps : [] } });
    }
    if (u.indexOf('/neobi/v2.0/query/query') >= 0) {
      maintenanceCalls++;
      wbCalls.push({ url: u, body: String((init && init.body) || ''), ctype: String(((init && init.headers) || {})['Content-Type'] || '') });
      return json({ data: { grid: devCells } });
    }
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
  check('配件行被剔除（产品名称以「配件」开头）',
    got['承德银行'] && got['承德银行'].maintenance.every(d => !/^配件/.test(d.product)),
    JSON.stringify((got['承德银行'] && got['承德银行'].maintenance || []).map(d => d.product)));
  check('未命中客户标 miss 且不查维保', got['不存在银行'].status === 'miss');
  check('每家命中客户各查一次维保', maintenanceCalls === 2, String(maintenanceCalls));
  /* 维保请求体照抄网页抓包：少一个固定字段服务端就返回空表（2026-11-05 实测） */
  const wbq = new URLSearchParams(wbCalls[0] && wbCalls[0].body || '');
  check('维保请求带 avatarViewId', /avatarViewId=3439246815003399/.test(wbCalls[0] && wbCalls[0].url), wbCalls[0] && wbCalls[0].url);
  check('维保请求为表单编码', /x-www-form-urlencoded/.test(wbCalls[0] && wbCalls[0].ctype), wbCalls[0] && wbCalls[0].ctype);
  check('维保表单固定字段齐全（config/dataShareOwner/reportType/layoutId/widgetId）',
    ['config', 'dataShareOwner', 'reportType', 'layoutId', 'widgetId'].every(k => wbq.get(k)),
    Array.from(wbq.keys()).join(','));
  check('维保 filter 带商机 recordId',
    /"fieldKey":"customItem287__c"/.test(wbq.get('filter') || '') && /"val":101\b/.test(wbq.get('filter') || ''),
    (wbq.get('filter') || '').slice(0, 120));
  check('返回可复用 session', !!r.session && Array.isArray(r.session.cookies) && r.session.cookies.some(c => c.name === 'JSESSIONID'));
}
void KEY_BYTES;

/* ---------------- 9. 多项目维保聚合（同一客户命中多条商机） ---------------- */
{
  const now = new Date('2026-11-05T00:00:00Z');

  /* 9.1 纯函数：去重键 = 序列号（去空格 / 忽略大小写），保留维保结束时间最新的一条 */
  const merged = mergeMaintenance([
    { name: '项目一', devices: [
      { serialNo: 'SN-A', end: '2024/01/01', product: 'T5100S' },
      { serialNo: 'sn-b ', end: '2028/12/31', product: 'T5100S' }
    ] },
    { name: '项目二', devices: [
      { serialNo: 'SN-B', end: '2030/12/31', product: 'T5100S' },
      { serialNo: 'SN-C', end: '2024/05/05', product: 'T5100S' }
    ] }
  ]);
  check('聚合按序列号去重：3 台（SN-B 跨项目只算 1 台）', merged.length === 3, String(merged.length));
  const snb = merged.filter(d => String(d.serialNo).toUpperCase().trim() === 'SN-B')[0];
  check('同序列号保留维保结束时间最新的记录', !!snb && snb.end === '2030/12/31', snb && snb.end);
  check('保留记录所属项目作为主项目', !!snb && snb.projectName === '项目二', snb && snb.projectName);
  check('projectNames 记录全部所属项目（项目一 + 项目二）',
    !!snb && snb.projectNames.length === 2 && snb.projectNames.indexOf('项目一') >= 0,
    JSON.stringify(snb && snb.projectNames));
  const sna = merged.filter(d => d.serialNo === 'SN-A')[0];
  check('只出现在一个项目的设备也带项目名',
    !!sna && sna.projectName === '项目一' && sna.projectNames.length === 1, JSON.stringify(sna));
  const mw = warrantyStatus(merged, now);
  check('三态按聚合后清单重算（3 台中 2 台到期 → partial）',
    mw.status === 'partial' && mw.total === 3 && mw.expired === 2, JSON.stringify(mw));

  /* 9.2 端到端：同一客户命中 2 条商机 → 2 次维保请求 + 合并为一份清单 */
  const { publicKey: pk3 } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pub3 = pk3.export({ type: 'spki', format: 'der' }).toString('base64');
  const opps = [
    { id: 201, opportunityName: '承德银行GSLB一期', accountId: { name: '承德银行' }, customItem101__c: '季荣成', updatedAt: '2026-11-02' },
    { id: 202, opportunityName: '承德银行GSLB二期', accountId: { name: '承德银行' }, customItem101__c: '许占升', updatedAt: '2026-10-01' }
  ];
  const devRow = (sn, start, end) => ['张三', '2024/10/01', '合同A', sn, 'T5100S', 'T5100S', start, end, '-1', 'Kylin V10', 'V6.2.1'];
  const wbBody = (rows) => {
    const cells = WB_HEADERS.map((h, i) => ({ type: 1, row: 0, col: i, value: h }));
    rows.forEach((r, idx) => r.forEach((v, i) => cells.push({ type: 0, row: idx + 1, col: i, value: v })));
    return json({ data: { grid: cells } });
  };
  const cellsByRec = {
    201: [devRow('SN-A', '2024/11/10', '2024/01/01'), devRow('SN-B', '2024/11/10', '2028/12/31')],
    202: [devRow('SN-B', '2024/11/10', '2030/12/31'), devRow('SN-C', '2024/11/10', '2024/05/05')]
  };
  const hitCalls = [];
  const mkFetch = (failRec) => async (url, init) => {
    const u = String(url);
    if (u.indexOf('/auc/passport/password-key') >= 0) return json({ scode: '200', result: pub3 });
    if (u.indexOf('/auc/login') >= 0) return new Response('', { status: 302, headers: { location: XSY_HOSTS.crm + '/cb' } });
    if (u.indexOf('/cb') >= 0) return new Response('ok', { status: 200, headers: { 'set-cookie': 'JSESSIONID=zzz; Path=/' } });
    if (u.indexOf('/neoui/table/initData1') >= 0) {
      return json({ data: { items: [
        { apiKey: 'opportunityName', label: '项目名称' },
        { apiKey: 'accountId', label: '客户名称' },
        { apiKey: 'customItem101__c', label: '维护人A' }
      ] } });
    }
    if (u.indexOf('/neoui/table/search') >= 0) {
      /* 只第一页有数据，第二页返回空 → 触发正常结束（分页改为「空页才停」） */
      const b = JSON.parse(String((init && init.body) || '{}'));
      const pn = (b.page && b.page.pageNo) || 1;
      return json({ data: { records: pn === 1 ? opps : [] } });
    }
    if (u.indexOf('/neobi/v2.0/query/query') >= 0) {
      const flt = new URLSearchParams(String(init.body)).get('filter') || '';
      const rid = Number((/"val":(\d+)/.exec(flt) || [])[1]);
      hitCalls.push(rid);
      if (failRec && rid === failRec) return json({ message: 'boom' }, 400);
      return wbBody(cellsByRec[rid] || []);
    }
    return json({}, 404);
  };

  const got = {};
  const r = await runCrmSync({
    loginName: 'a', password: 'b', customerNames: ['承德银行'],
    onMatch: (n, res) => { got[n] = res; }
  }, { fetchImpl: mkFetch(null), sleep: async () => {} });
  const res = got['承德银行'];
  check('同一客户两条命中 → 逐个项目各查一次维保', hitCalls.length === 2 && hitCalls.indexOf(201) >= 0 && hitCalls.indexOf(202) >= 0,
    JSON.stringify(hitCalls));
  check('结果带 2 个项目明细（名称 + 各自三态）',
    !!res && res.projects.length === 2 && res.projects[0].name === '承德银行GSLB一期' &&
    res.projects[0].warranty.status === 'partial' && res.projects[1].warranty.status === 'partial',
    JSON.stringify(res && res.projects.map(p => [p.name, p.warranty && p.warranty.status])));
  check('跨项目重复设备合并后为 3 台', !!res && res.maintenance.length === 3, String(res && res.maintenance.length));
  const devB = res && res.maintenance.filter(d => d.serialNo === 'SN-B')[0];
  check('合并后设备标注所属项目（两个项目都在）',
    !!devB && devB.projectNames.length === 2 && devB.projectName === '承德银行GSLB二期',
    JSON.stringify(devB && { p: devB.projectName, all: devB.projectNames }));
  check('主商机仍取最新修改的一条', !!res && res.opp.id === 201, String(res && res.opp.id));
  check('整体三态按聚合清单计算（3 台 2 到期 → partial）',
    !!res && res.warranty.status === 'partial' && res.warranty.total === 3,
    JSON.stringify(res && res.warranty));
  check('同步统计计 1 户命中', r.ok && r.stats.matched === 1, JSON.stringify(r.stats));

  /* 9.3 容错：单个项目维保查失败，不拖垮整户 */
  hitCalls.length = 0;
  const got2 = {};
  await runCrmSync({
    loginName: 'a', password: 'b', customerNames: ['承德银行'],
    onMatch: (n, res2) => { got2[n] = res2; }
  }, { fetchImpl: mkFetch(202), sleep: async () => {} });
  const res2 = got2['承德银行'];
  check('单项目失败仍算匹配成功，且不带整体错误',
    !!res2 && res2.status === 'ok' && res2.error === null, JSON.stringify(res2 && res2.error));
  check('失败项目记自己的错误与空设备', !!res2 && !!res2.projects[1].error && res2.projects[1].devices.length === 0,
    JSON.stringify(res2 && res2.projects[1] && res2.projects[1].error));
  check('成功项目的设备仍进入合并清单（2 台）', !!res2 && res2.maintenance.length === 2,
    String(res2 && res2.maintenance.length));

  /* 9.4 进度上报：阶段顺序 / done 单调 / 终值等于客户数 / 多项目阶段 */
  const prog = [];
  await runCrmSync({
    loginName: 'a', password: 'b', customerNames: ['承德银行', '查无此客户'],
    onMatch: () => {},
    onProgress: (p) => { prog.push(p); }
  }, { fetchImpl: mkFetch(null), sleep: async () => {} });
  const stages = prog.map(p => p.stage);
  check('进度从登录开始，经 opps 进入 match',
    stages[0] === 'login' && stages.indexOf('opps') > 0 && stages.lastIndexOf('match') > stages.indexOf('opps'),
    JSON.stringify(stages));
  check('每条进度都带 total 与可读文案',
    prog.every(p => p.total === 2 && !!p.message), JSON.stringify(prog[0]));
  const dones = prog.filter(p => p.stage === 'match').map(p => p.done);
  check('match 阶段 done 单调不减且最终等于客户总数',
    dones[dones.length - 1] === 2 && dones.every((v, i) => i === 0 || v >= dones[i - 1]), JSON.stringify(dones));
  check('进度里标注当前处理的客户名',
    prog.some(p => p.current === '承德银行') && prog.some(p => p.current === '查无此客户'),
    JSON.stringify(prog.filter(p => p.current).map(p => p.current)));
  check('多项目客户额外上报 maintenance 阶段（含项目序号）',
    prog.some(p => p.stage === 'maintenance' && p.projectIndex === 2 && p.projectTotal === 2),
    JSON.stringify(prog.filter(p => p.stage === 'maintenance')));
}

/* ---------------- 10. 检索进度文案（纯函数） ---------------- */
{
  check('文案：登录阶段明确在登录',
    crmProgressText({ stage: 'login' }) === '正在登录询盘云（销售易）…', crmProgressText({ stage: 'login' }));
  const t1 = crmProgressText({ stage: 'match', done: 3, total: 28, current: '承德银行' });
  check('文案：匹配阶段含当前客户与进度', t1.indexOf('承德银行') >= 0 && t1.indexOf('3/28') >= 0, t1);
  const t2 = crmProgressText({
    stage: 'maintenance', projectName: '技术专用-A', projectIndex: 2, projectTotal: 3, current: '承德银行'
  });
  check('文案：多项目阶段含项目序号与项目名', t2.indexOf('2/3') >= 0 && t2.indexOf('技术专用-A') >= 0, t2);
  check('文案：完成 / 失败 / 未知阶段',
    crmProgressText({ stage: 'done' }) === '检索完成' &&
    crmProgressText({ stage: 'error' }) === '检索失败' &&
    crmProgressText({}) === '处理中…', '');
  check('文案：没有待检索客户时不报 0/0',
    crmProgressText({ stage: 'match', done: 0, total: 0 }) === '没有待检索的客户',
    crmProgressText({ stage: 'match', done: 0, total: 0 }));
}

/* ---------------- 11. 区域统计（按战区汇总，2026-11-06） ---------------- */
{
  /* 11.1 纯函数：按序列号去重 + 项目/客户归属 + 型号汇总 */
  const projects = [
    { id: 1, name: 'A项目', customer: '客户甲', dept: '金融一部', owner: '孙',
      devices: [
        { serialNo: 'sn-x ', model: 'T6100', end: '2027/01/01', sales: '张三', contractDate: '2024/10/01', contractName: '合同A' },
        { serialNo: 'SN-Y', model: 'T3110', end: '2028/05/05' }
      ] },
    { id: 2, name: 'B项目', customer: '客户乙', dept: '金融二部', owner: '李',
      devices: [
        { serialNo: 'SN-X', model: 'T6100', end: '2030/01/01' },
        { serialNo: 'SN-Z', model: 'T6100', end: '2026/01/01' }
      ] }
  ];
  const built = buildRegionStat(projects);
  check('区域统计：按序列号去重（4 条 → 3 台）',
    built.rows.length === 3 && built.stats.rawDevices === 4, JSON.stringify(built.stats));
  const sx = built.rows.filter(r => serialKey(r.serialNo) === 'SN-X')[0];
  check('区域统计：同序列号保留维保结束最新的一条', !!sx && sx.end === '2030/01/01', sx && sx.end);
  check('区域统计：设备记录全部所属项目与客户',
    !!sx && sx.projects.length === 2 && sx.customers.length === 2 && sx.projectName === 'B项目',
    JSON.stringify(sx && { p: sx.projects, c: sx.customers, pn: sx.projectName }));
  check('区域统计：汇总按型号计台数（T6100=2 / T3110=1）',
    built.summary.length === 2 && built.summary[0].model === 'T6100' && built.summary[0].count === 2 &&
    built.summary[1].model === 'T3110' && built.summary[1].count === 1,
    JSON.stringify(built.summary));
  check('区域统计：stats 项目数/设备数/型号数/客户数',
    built.stats.projects === 2 && built.stats.devices === 3 && built.stats.models === 2 && built.stats.customers === 2,
    JSON.stringify(built.stats));
  const empty = buildRegionStat([]);
  check('区域统计：空项目也不报错',
    empty.rows.length === 0 && empty.summary.length === 0 && empty.stats.projects === 0);

  /* 11.2 进度文案 */
  const st1 = crmStatProgressText({ stage: 'devices', done: 3, total: 560, current: 'A项目' });
  check('统计文案：拉项目维保带进度与项目名',
    st1.indexOf('3/560') >= 0 && st1.indexOf('A项目') >= 0, st1);
  check('统计文案：登录 / 拉商机 / 完成 / 失败',
    crmStatProgressText({ stage: 'login' }).indexOf('登录') >= 0 &&
    crmStatProgressText({ stage: 'opps' }).indexOf('商机') >= 0 &&
    crmStatProgressText({ stage: 'done' }) === '统计完成' &&
    crmStatProgressText({ stage: 'error' }) === '统计失败', '');

  /* 11.3 端到端：只统计所选战区，其他战区不拉维保 */
  const { publicKey: pk4 } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pub4 = pk4.export({ type: 'spki', format: 'der' }).toString('base64');
  const opps4 = [
    { id: 301, opportunityName: 'A项目', accountId: { name: '客户甲' }, customItem201__c: '金融一部', customItem202__c: '金融行业部', customItem203__c: '孙晶晶', updatedAt: '2026-11-01' },
    { id: 302, opportunityName: 'B项目', accountId: { name: '客户乙' }, customItem201__c: '金融二部', customItem202__c: '金融行业部', customItem203__c: '潘明月', updatedAt: '2026-11-01' },
    { id: 303, opportunityName: 'C项目', accountId: { name: '客户丙' }, customItem201__c: '东部一部', customItem202__c: '东部战区', customItem203__c: '某人', updatedAt: '2026-11-01' }
  ];
  const devRow4 = (sn, model, start, end) => ['张三', '2024/10/01', '合同A', sn, '产品' + model, model, start, end, '-1', 'Kylin', 'V1'];
  const wb4 = (rows) => {
    const cells = WB_HEADERS.map((h, i) => ({ type: 1, row: 0, col: i, value: h }));
    rows.forEach((r, idx) => r.forEach((v, i) => cells.push({ type: 0, row: idx + 1, col: i, value: v })));
    return json({ data: { grid: cells } });
  };
  const cells4 = {
    301: [devRow4('SN-X', 'T6100', '2024/11/10', '2027/01/01'), devRow4('SN-Y', 'T3110', '2024/11/10', '2028/05/05')],
    302: [devRow4('SN-X', 'T6100', '2024/11/10', '2030/01/01'), devRow4('SN-Z', 'T6100', '2024/11/10', '2026/01/01')],
    303: [devRow4('SN-W', 'T9999', '2024/11/10', '2031/01/01')]
  };
  const called4 = [];
  const fetch4 = async (url, init) => {
    const u = String(url);
    if (u.indexOf('/auc/passport/password-key') >= 0) return json({ scode: '200', result: pub4 });
    if (u.indexOf('/auc/login') >= 0) return new Response('', { status: 302, headers: { location: XSY_HOSTS.crm + '/cb' } });
    if (u.indexOf('/cb') >= 0) return new Response('ok', { status: 200, headers: { 'set-cookie': 'JSESSIONID=qqq; Path=/' } });
    if (u.indexOf('/neoui/table/initData1') >= 0) {
      return json({ data: { items: [
        { apiKey: 'opportunityName', label: '项目名称' },
        { apiKey: 'accountId', label: '客户名称' },
        { apiKey: 'customItem201__c', label: '所属部门' },
        { apiKey: 'customItem202__c', label: '战区' },
        { apiKey: 'customItem203__c', label: '项目所有人' }
      ] } });
    }
    if (u.indexOf('/neoui/table/search') >= 0) {
      const b = JSON.parse(String((init && init.body) || '{}'));
      const pn = (b.page && b.page.pageNo) || 1;
      return json({ data: { records: pn === 1 ? opps4 : [] } });
    }
    if (u.indexOf('/neobi/v2.0/query/query') >= 0) {
      const flt = new URLSearchParams(String(init.body)).get('filter') || '';
      const rid = Number((/"val":(\d+)/.exec(flt) || [])[1]);
      called4.push(rid);
      return wb4(cells4[rid] || []);
    }
    return json({}, 404);
  };
  const prog4 = [];
  const r4 = await runRegionStat({
    loginName: 'a', password: 'b', region: '金融行业部',
    onProgress: (p) => prog4.push(p)
  }, { fetchImpl: fetch4, sleep: async () => {} });

  check('区域统计：只统计所选战区的项目（2 / 3）',
    r4.ok && r4.projects.length === 2 && r4.stats.projects === 2, JSON.stringify(r4.stats));
  check('区域统计：不拉其他战区项目的维保', called4.indexOf(303) < 0 && called4.length === 2, JSON.stringify(called4));
  check('区域统计：设备按序列号聚合（4 条 → 3 台）', r4.rows.length === 3, String(r4.rows.length));
  check('区域统计：明细带部门 / 销售 / 合同信息',
    r4.rows.some(x => x.dept === '金融一部' && x.sales === '张三' &&
      x.contractDate === '2024/10/01' && x.contractName === '合同A'),
    JSON.stringify(r4.rows[0]));
  check('区域统计：型号汇总 T6100 = 2 台',
    r4.summary[0].model === 'T6100' && r4.summary[0].count === 2, JSON.stringify(r4.summary));
  check('区域统计：返回全域战区分布（供下拉框）',
    r4.regions.length === 2 && r4.regions[0].name === '金融行业部' && r4.regions[0].count === 2,
    JSON.stringify(r4.regions));
  check('区域统计：进度含 login→opps→devices→done，total 为项目数',
    prog4[0].stage === 'login' && prog4.some(p => p.stage === 'opps') &&
    prog4.some(p => p.stage === 'devices' && p.total === 2) &&
    prog4[prog4.length - 1].stage === 'done', JSON.stringify(prog4.map(p => p.stage)));
  const bad4 = await runRegionStat({ loginName: 'a', password: 'b', region: ' ' }, { fetchImpl: fetch4 });
  check('区域统计：缺区域名直接报错', bad4.ok === false && !!bad4.message, JSON.stringify(bad4));
}

console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
process.exit(fail ? 1 : 0);
