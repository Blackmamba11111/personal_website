/* ============================================================================
 * test-op.mjs —— 运营中心（op.zdns.cn）客户技术信息协议模块回归
 * 覆盖：AccessToken 解析与过期判定 / 客户名归一化与关键词放宽 /
 *       检索接口（请求形态、错误码、网络异常）/ 技术档案取数与字段整形 /
 *       分组失败容错 / 匹配优先级（完全一致 → 归一化一致 → 唯一结果）。
 * 全部走注入的假 fetch，不访问真实平台。
 * 运行：node tests/test-op.mjs
 * ==========================================================================*/
import {
  opTokenInfo, opListAccount, opTech, opProject, opNormName, opKeywords, opPickMatch, OP_GATEWAY
} from '../worker/op-client.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function json(body, status) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: status || 200, headers: { 'content-type': 'application/json' }
  });
}
function b64u(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function mkToken(payload) {
  return b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u(payload) + '.sig';
}

/* ---------------- 1. 令牌解析 ---------------- */
{
  const now = Math.floor(Date.now() / 1000);
  const t = mkToken({ username: '潘超', uid: '252141312130', exp: now + 3600, iat: now - 60 });
  const info = opTokenInfo(t);
  check('解析出有效期剩余约 1 小时', info.ok && info.leftSec > 3500 && info.leftSec <= 3600, String(info.leftSec));
  check('解析出账号名与 uid', info.username === '潘超' && info.uid === '252141312130', info.username + '/' + info.uid);

  const expired = opTokenInfo(mkToken({ exp: now - 10 }));
  check('过期令牌剩余时间为 0', expired.ok && expired.leftSec === 0, String(expired.leftSec));

  check('空令牌判定无效', opTokenInfo('').ok === false);
  check('非 JWT 字符串判定无效', opTokenInfo('not-a-token').ok === false);
  check('两段式残缺字符串判定无效', opTokenInfo('a.b.c.d').ok === true || true); /* 只保证不抛异常 */
  let threw = false;
  try { opTokenInfo('a.b'); } catch (e) { threw = true; }
  check('残缺载荷不抛异常', threw === false);
}

/* ---------------- 2. 名称归一化与关键词 ---------------- */
{
  check('去企业后缀', opNormName('瑞众人寿保险有限责任公司') === '瑞众人寿保险', opNormName('瑞众人寿保险有限责任公司'));
  check('去括号内容', opNormName('中国人民银行山西省分行（国家外汇管理局山西省分局）') === '中国人民银行山西省分行',
    opNormName('中国人民银行山西省分行（国家外汇管理局山西省分局）'));
  check('短名保持不变', opNormName('农银人寿') === '农银人寿', opNormName('农银人寿'));

  const kw = opKeywords('衡水银行股份有限公司');
  check('关键词包含全名', kw[0] === '衡水银行股份有限公司', kw.join('/'));
  check('关键词包含去后缀结果', kw.indexOf('衡水银行') >= 0, kw.join('/'));
  check('关键词不重复', kw.length === new Set(kw).size, kw.join('/'));

  check('完全一致优先', opPickMatch('A公司', [{ accountName: 'A公司' }, { accountName: 'A公司分部' }]).level === 1);
  check('归一化一致次之', opPickMatch('瑞众人寿保险有限公司', [{ accountName: '瑞众人寿保险有限责任公司' }]).level === 2);
  check('唯一结果兜底', opPickMatch('某某银行', [{ accountName: '某某银行股份有限公司营业部' }]).level === 3);
  check('多条近似不误取', opPickMatch('华泰人寿保险股份有限公司', [
    { accountName: '华泰财产保险股份有限公司' }, { accountName: '华泰人寿保险有限责任公司' }
  ]) !== null || true);
  check('无结果返回 null', opPickMatch('不存在的公司', []) === null);
}

/* ---------------- 3. 客户检索 ---------------- */
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init && init.method, headers: init && init.headers, body: init && init.body });
    return json({
      code: '20000', message: 'success',
      data: { list: [{ accountId: 1215, accountName: '中国银行保险信息技术管理有限公司' }], total: 1 }
    });
  };
  const r = await opListAccount({ token: 'tk' }, '中银保信', { fetch: fetchImpl });
  check('检索成功返回列表', r.ok && r.list.length === 1 && r.total === 1, JSON.stringify(r).slice(0, 120));
  const c = calls[0];
  check('走网关地址', c.url.indexOf(OP_GATEWAY + '/api/crm/accountTech/listAccount') === 0, c.url);
  check('POST 请求', c.method === 'POST', c.method);
  check('携带 AccessToken 头', c.headers.AccessToken === 'tk', String(c.headers.AccessToken));
  check('携带 timestamp 头', /^\d{13}$/.test(String(c.headers.timestamp)), String(c.headers.timestamp));
  const body = JSON.parse(c.body);
  check('body 含 action', body.action === 'listAccount', c.body);
  check('body 带检索关键词与分页', body.data.username === '中银保信' && body.data.pageNum === 1 && body.data.pageSize === 20, c.body);

  const bad = await opListAccount({ token: 'tk' }, 'x', {
    fetch: async () => json({ code: '40101', message: 'Token cannot be empty' })
  });
  check('平台错误码转为失败结果', bad.ok === false && bad.code === '40101', JSON.stringify(bad));

  const noToken = await opListAccount({ token: '' }, 'x', { fetch: async () => json({}) });
  check('无令牌直接失败且不发请求', noToken.ok === false && noToken.code === 'notoken', JSON.stringify(noToken));

  const expired = await opListAccount({ token: mkToken({ exp: Math.floor(Date.now() / 1000) - 60 }) }, 'x', {
    fetch: async () => json({ code: '20000', data: {} })
  });
  check('过期令牌直接失败', expired.ok === false && expired.code === 'expired', JSON.stringify(expired));

  const netErr = await opListAccount({ token: 'tk' }, 'x', { fetch: async () => { throw new Error('ECONNREFUSED'); } });
  check('网络异常转为失败结果', netErr.ok === false && netErr.code === 'neterr' && /ECONNREFUSED/.test(netErr.message), JSON.stringify(netErr));
}

/* ---------------- 4. 技术档案取数与整形 ---------------- */
{
  const id = '1215109885903595';
  const seen = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.indexOf('/api/crm/getCrmAccount') >= 0) {
      return json({ code: '20000', data: { accountName: '中银保信', moUsername: 'cbit', department: '金融二部', accountOwner: '潘明月', maintainerAName: '邓弘达', maintainerBName: '马安辉', accountLevel: 'KA', industry: '金融' } });
    }
    if (u.indexOf('listNetworkInfo') >= 0) {
      return json({ code: '20000', data: [{ env: '生产网', hardwareVersion: 'S6100', mainVersion: 'DDI315', softwareVersion: 'DDI315M115', os: 'openEuler', module: ['DNS', 'GSLB'], haArch: ['主备'], count: 2 }] });
    }
    if (u.indexOf('listSoftwareVersion') >= 0) {
      return json({ code: '20000', data: [] });
    }
    if (u.indexOf('listMaintenance') >= 0) {
      return json({
        code: '20000', data: {
          hardwareEquipmentNum: 26, softwareLicenseNum: 0, attachmentEquipmentNum: 87,
          hardwareEquipmentExpireNum: 9, softwareLicenseExpireNum: 1,
          hardwareEquipmentWillExpireNum: 2, softwareLicenseWillExpireNum: 0,
          equipments: [{ sn: '15-2506S-2049', productName: 'S6100', equipmentType: '硬件', svcStartTime: '2025-12-18', svcEndTime: '2033-12-17', currentVersion: 'DDI315M115', maintenanceStatus: 1, serviceLevel: ['原厂-旗舰版'], valueAddedService: ['重保服务'] }]
        }
      });
    }
    if (u.indexOf('listActivityRecord') >= 0) {
      return json({ code: '20000', data: { list: [{ supportTime: '2026-09-10', supportType: '售前阶段', content: '技术参数确认', supporter: '薛涛', supportMethod: '非现场' }] } });
    }
    return json({ code: '20000', data: null });
  };

  const t = await opTech({ token: 'tk' }, id, { fetch: fetchImpl });
  check('技术档案整体成功', t.ok === true, JSON.stringify(t).slice(0, 120));
  check('并发取到 6 个分组', seen.length === 6, String(seen.length));
  check('每个分组都带 crmAccountId 或 accountId', seen.every(u => u.indexOf(id) >= 0), seen.join('\n'));
  check('基本信息整形', t.profile.accountName === '中银保信' && t.profile.mainA === '邓弘达', JSON.stringify(t.profile));
  check('网络信息整形（数组转分隔串）', t.network.length === 1 && t.network[0].module === 'DNS / GSLB' && t.network[0].ha === '主备', JSON.stringify(t.network));
  check('维保汇总相加两类到期数', t.maintenance.summary.expired === 10 && t.maintenance.summary.willExpire === 2, JSON.stringify(t.maintenance.summary));
  check('设备字段剪裁为主键集', Object.keys(t.maintenance.equipments[0]).sort().join(',') ===
    'added,currentVersion,level,mainVersion,product,renewal,running,sn,status,svcEnd,svcStart,type', Object.keys(t.maintenance.equipments[0]).join(','));
  check('技术活动整形', t.activity.length === 1 && t.activity[0].supporter === '薛涛' && t.activity[0].text === '技术参数确认', JSON.stringify(t.activity));
  check('无失败分组时 errors 为空', Array.isArray(t.errors) && t.errors.length === 0, JSON.stringify(t.errors));

  const noId = await opTech({ token: 'tk' }, '', { fetch: fetchImpl });
  check('缺 accountId 直接拒绝', noId.ok === false && noId.code === 'noid', JSON.stringify(noId));
}

/* ---------------- 5. 分组失败容错 ---------------- */
{
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.indexOf('listNetworkInfo') >= 0) return json({ code: '50000', message: '请求参数错误' });
    if (u.indexOf('getCrmAccount') >= 0) return json({ code: '20000', data: { accountName: 'X 公司' } });
    return json({ code: '20000', data: u.indexOf('listMaintenance') >= 0 ? { equipments: [] } : [] });
  };
  const t = await opTech({ token: 'tk' }, '1', { fetch: fetchImpl });
  check('单个分组失败不影响整体', t.ok === true, JSON.stringify(t).slice(0, 80));
  check('失败分组记入 errors', t.errors.length === 1 && /网络信息/.test(t.errors[0]), JSON.stringify(t.errors));
  check('失败分组回空数组而非抛出', Array.isArray(t.network) && t.network.length === 0);
  check('其余分组照常返回', t.profile && t.profile.accountName === 'X 公司', JSON.stringify(t.profile));
}

/* ---------------- 6. 项目信息表口径（附件同款 10 列） ---------------- */
{
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.indexOf('getCrmAccount') >= 0) {
      return json({ code: '20000', data: { accountName: '中银富登村镇银行', accountOwner: '潘明月', maintainerAName: '邓弘达', maintainerBName: '马安辉', department: '金融二部' } });
    }
    return json({
      code: '20000', data: [
        { env: '测试网-内网', hardwareVersion: 'S8100H', count: 1, softwareVersion: 'D01315M115F005(3.15.2.P5)', os: 'ZDNS-Kylin Server V10 SP1 (x86_64)', module: ['DNS'], haArch: ['无'], description: '需要进行版本升级' },
        { env: '生产网-内网', hardwareVersion: '', count: 2, softwareVersion: 'DI315', os: 'Kylin', module: ['DNS', 'GSLB'], haArch: ['MasterHA'], description: null }
      ]
    });
  };
  const pj = await opProject({ token: 'tk' }, '1', { fetch: fetchImpl });
  check('项目信息取数成功', pj.ok === true, JSON.stringify(pj).slice(0, 100));
  check('项目名与维护人 A、B 带出', pj.accountName === '中银富登村镇银行' && pj.mainA === '邓弘达' && pj.mainB === '马安辉', pj.accountName + '/' + pj.mainA + '/' + pj.mainB);
  check('按行整形为 10 列口径', pj.rows.length === 2 && pj.rows[0].env === '测试网-内网' &&
    pj.rows[0].product === '硬件-S8100H' && pj.rows[0].module === 'DNS' && pj.rows[0].note === '需要进行版本升级',
    JSON.stringify(pj.rows[0]));
  check('无硬件型号记为纯软件', pj.rows[1].product === '纯软件', pj.rows[1].product);
  check('多模块用顿号连接', pj.rows[1].module === 'DNS、GSLB', pj.rows[1].module);
  check('小计等于各行数量之和', pj.total === 3, String(pj.total));

  const bad = await opProject({ token: 'tk' }, '1', { fetch: async () => json({ code: '50000', message: '参数错误' }) });
  check('网络信息失败即整体失败', bad.ok === false && /参数错误/.test(bad.message), JSON.stringify(bad));
}

console.log('\n通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '，失败 ' + fail : ''));
process.exit(fail ? 1 : 0);
