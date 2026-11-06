/* ============================================================================
 * Worker 版接口测试（用 node:sqlite 模拟 D1）
 * 目的：worker/index.js 与内网 server.js 是两份实现，SQL 写错只有上线才暴露。
 *      这里用最小 D1 兼容层 + 内存 SQLite 直接调用 Worker 的 fetch，
 *      覆盖「老库补列 → 建认证服务器 → 建远程/只读用户 → 登录 → 权限拦截」全链路。
 * 运行：node tests/test-worker-api.mjs
 * ==========================================================================*/
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const db = new DatabaseSync(':memory:');
/* 刻意建「老结构」的 users 表（没有 source / perm / server_id），
   用来验证 ensureSchema 的 ALTER 迁移在 D1 上同样有效 */
db.exec(`
CREATE TABLE users (
  username TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active', note TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL, hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_login TEXT NOT NULL DEFAULT ''
);
CREATE TABLE ledgers (username TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '');
CREATE TABLE sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
`);

/* 预置一个初始超管（与 schema.sql 同一条记录） */
db.prepare('INSERT INTO users (username,name,role,status,note,salt,hash,must_change,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('admin', '超级管理员', 'admin', 'active', '', 'Sa64bc60c760738d3',
    '0951988844fabe13ab97e7b6c9f0f1edcd10f68efaf9a42dba7cfd6086768237', 1, '2026-10-14T08:46:23.603Z');

/* ---------------- 最小 D1 兼容层 ---------------- */
class Stmt {
  constructor(sql, args) { this.sql = sql; this.args = args || []; }
  bind(...args) { return new Stmt(this.sql, args); }
  async first() {
    const row = db.prepare(this.sql).get(...this.args);
    return row || null;
  }
  async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
  async run() {
    const r = db.prepare(this.sql).run(...this.args);
    return { meta: { changes: r.changes } };
  }
}
const D1 = {
  prepare(sql) { return new Stmt(sql); },
  async batch(list) { return Promise.all(list.map(s => s.run())); }
};
const env = {
  DB: D1,
  ASSETS: { fetch: async () => new Response('asset', { headers: { 'content-type': 'text/html' } }) }
};

const BASE = 'https://example.test';
async function api(path, opts = {}, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const req = new Request(BASE + '/api' + path, {
    method: opts.method || 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const res = await worker.fetch(req, env);
  const j = await res.json().catch(() => ({}));
  return Object.assign({ status: res.status }, j);
}

/* 1. 老库迁移 + 登录 */
let r = await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin888' } });
check('老库自动补列后仍能登录', r.ok === true, JSON.stringify(r));
check('bundle 带 canWrite=true（超管）', r.data && r.data.canWrite === true);
check('bundle 带 authServers 空数组', Array.isArray(r.data.authServers) && r.data.authServers.length === 0);
check('老用户 source 默认 local', r.data.user.source === 'local' && r.data.user.perm === 'rw');
const tk = r.data.token;

/* 2. 认证服务器 CRUD */
r = await api('/auth-servers', { method: 'POST', body: { name: '测试 LDAP', type: 'ldap', host: '127.0.0.1', port: 389, cfg: { bindPattern: 'uid={user},dc=x' } } }, tk);
check('新增 LDAP 服务器', r.ok === true, JSON.stringify(r));
const srvId = r.data && r.data.server && r.data.server.id;

r = await api('/auth-servers', { method: 'POST', body: { name: '空密钥 RADIUS', type: 'radius', host: '10.0.0.1' } }, tk);
check('RADIUS 缺 secret 被拒', r.ok === false && /共享密钥/.test(r.error), JSON.stringify(r));

r = await api('/auth-servers', { method: 'GET' }, tk);
check('列表返回服务器且不回传 secret', r.ok && r.data.servers.length === 1 && r.data.servers[0].hasSecret === false);
check('列表带默认端口', r.data.servers[0].port === 389);

/* 3. 远程用户 */
r = await api('/users', { method: 'POST', body: { username: 'raduser', name: '远程用户', perm: 'ro', serverId: srvId, password: 'should-fail' } }, tk);
check('远程用户不允许设本地密码', r.ok === false && /服务器校验/.test(r.error), JSON.stringify(r));

r = await api('/users', { method: 'POST', body: { username: 'raduser', name: '远程用户', perm: 'ro', serverId: srvId } }, tk);
check('创建远程只读用户', r.ok === true, JSON.stringify(r));
check('来源取服务器类型 ldap', r.data.user.source === 'ldap' && r.data.user.perm === 'ro');
check('带出服务器名', r.data.user.serverName === '测试 LDAP');

r = await api('/users', { method: 'POST', body: { username: 'raduser', name: 'x', perm: 'rw', serverId: srvId } }, tk);
check('同名用户拒绝重复创建', r.ok === false && /已存在/.test(r.error));

/* 4. 远程用户登录：TCP 连不上应给出「认证服务不可用」而非 500 */
r = await api('/auth/login', { method: 'POST', body: { username: 'raduser', password: 'x' } });
check('远程登录失败给出可读错误', r.ok === false && r.status >= 400, JSON.stringify(r));

/* 5. 只读本地用户 */
r = await api('/users', { method: 'POST', body: { username: 'viewer', name: '只读用户', perm: 'ro', password: 'View@123' } }, tk);
check('创建本地只读用户', r.ok === true, JSON.stringify(r));
check('本地用户 source=local', r.data.user.source === 'local' && r.data.user.perm === 'ro');

r = await api('/auth/login', { method: 'POST', body: { username: 'viewer', password: 'View@123' } });
check('只读用户能登录', r.ok === true, JSON.stringify(r));
check('只读用户 canWrite=false', r.data.canWrite === false);
const vk = r.data.token;

r = await api('/ledger', { method: 'PUT', body: { scope: 'viewer', data: { regions: [], customers: [], visits: [] } } }, vk);
check('只读用户写台账被拒 403', r.status === 403 && /只读权限/.test(r.error), JSON.stringify(r));

r = await api('/attach', { method: 'POST', body: { name: 'a.txt', mime: 'text/plain', data: 'aGVsbG8=' } }, vk);
check('只读用户上传附件被拒 403', r.status === 403, JSON.stringify(r));

r = await api('/auth/password', { method: 'POST', body: { oldPassword: 'View@123', newPassword: 'View@456' } }, vk);
check('本地用户可自助改密', r.ok === true, JSON.stringify(r));

/* 6. 管理端一致性 */
r = await api('/auth-servers/' + srvId, { method: 'DELETE' }, tk);
check('服务器仍被引用时禁止删除', r.ok === false && /仍有 1 个账号/.test(r.error), JSON.stringify(r));

r = await api('/users/raduser', { method: 'PATCH', body: { serverId: '', perm: 'rw' } }, tk);
check('远程改本地但没给密码 → 拒绝', r.ok === false && /初始密码/.test(r.error), JSON.stringify(r));

r = await api('/users/raduser', { method: 'PATCH', body: { serverId: '', password: 'Local@123' } }, tk);
check('远程改本地并设密码 → 成功', r.ok === true && r.data.user.source === 'local', JSON.stringify(r));

r = await api('/auth/login', { method: 'POST', body: { username: 'raduser', password: 'Local@123' } });
check('改为本地后可用新密码登录', r.ok === true, JSON.stringify(r));
check('改本地后 mustChange=true（强制改初始密码）', r.data.user.mustChange === true);

r = await api('/auth-servers/' + srvId, { method: 'DELETE' }, tk);
check('解除引用后可删除服务器', r.ok === true, JSON.stringify(r));

/* 7. 非管理员不得触碰用户/服务器接口 */
r = await api('/auth-servers', { method: 'GET' }, vk);
check('普通用户看不到认证服务器', r.status === 403);
r = await api('/users', { method: 'GET' }, vk);
check('普通用户看不到用户列表', r.status === 403);

/* 8. 共享数据集 + 变更日志 */
r = await api('/users', { method: 'POST', body: { username: 'sharer', name: '数据源用户', password: 'Share@123' } }, tk);
check('创建数据源用户', r.ok === true, JSON.stringify(r));
r = await api('/users', { method: 'POST', body: { username: 'member1', name: '共享成员', password: 'Member@123', shareFrom: 'sharer' } }, tk);
check('创建共享成员（shareFrom 记录归属）', r.ok === true && r.data.user.shareFrom === 'sharer', JSON.stringify(r));
r = await api('/users', { method: 'POST', body: { username: 'member2', name: '共享成员2', password: 'Member@456', shareFrom: 'member1' } }, tk);
check('成员再被共享时解析到归属者（一层）', r.ok === true && r.data.user.shareFrom === 'sharer', JSON.stringify(r));

const ownerData = { regions: [{ id: 'r1', name: '河北' }], customers: [{ id: 'c1', name: '客户甲', phone: '', contact: '' }], visits: [] };
r = await api('/ledger', { method: 'PUT', body: { scope: 'member1', data: ownerData } }, tk);
check('共享成员写台账落在归属者名下', r.ok === true, JSON.stringify(r));

r = await api('/auth/login', { method: 'POST', body: { username: 'member2', password: 'Member@456' } });
const mk = r.data.token;
r = await api('/ledger', { method: 'GET' }, mk);
check('成员登录即见共享数据', r.ok && r.data.ledgers.member2 &&
  r.data.ledgers.member2.customers.length === 1 && r.data.ledgers.member2.customers[0].name === '客户甲',
  JSON.stringify(r.data && r.data.ledgers && Object.keys(r.data.ledgers)));

ownerData.customers[0].phone = '13800000000';
r = await api('/ledger', { method: 'PUT', body: { scope: 'member2', data: ownerData } }, mk);
check('成员2（登录态）写共享数据成功', r.ok === true, JSON.stringify(r));

r = await api('/logs?username=member2', {}, tk);
check('日志按归属查询（owner=sharer）', r.ok && r.data.owner === 'sharer', JSON.stringify(r.data && r.data.owner));
const lg = r.data.logs || [];
check('日志含成员写失败的来源（只记成功写）与两次写入', lg.length === 2, JSON.stringify(lg));
check('日志记录 actor 与字段级明细', lg.some(l => l.actor === 'member2' && l.detail.indexOf('联系电话') >= 0),
  JSON.stringify(lg));
r = await api('/logs?username=viewer', {}, mk);
check('成员不能看他人日志', r.status === 403, JSON.stringify(r));

/* 删除归属者 → 数据/日志/成员转移给最早成员 */
r = await api('/users/sharer', { method: 'DELETE' }, tk);
check('删除归属者成功', r.ok === true, JSON.stringify(r));
r = await api('/users', { method: 'GET' }, tk);
const m1 = (r.data.users || []).filter(u => u.username === 'member1')[0];
const m2 = (r.data.users || []).filter(u => u.username === 'member2')[0];
check('最早成员转正为归属者', m1.shareFrom === '' && m2.shareFrom === 'member1', JSON.stringify([m1.shareFrom, m2.shareFrom]));
r = await api('/ledger', { method: 'GET' }, mk);
check('转移后成员数据仍在（归 member1）', r.ok && r.data.ledgers.member2 && r.data.ledgers.member2.customers[0].phone === '13800000000',
  JSON.stringify(r.data && r.data.ledgers && Object.keys(r.data.ledgers)));

/* 9. 敏感字段（详细地址/联系人电话）按用户隐藏：服务端打码下发 + 写入回填原值 */
r = await api('/users', { method: 'POST', body: { username: 'sensw', name: '受限户', password: 'Sens@123', hideSensitive: true } }, tk);
check('创建带 hideSensitive 的用户', r.ok === true && r.data.user.hideSensitive === true, JSON.stringify(r.data && r.data.user));

const sensData = { regions: [], customers: [
  { id: 's1', name: '敏感客户', addr: '河北省衡水市桃城区人民东路528号', phone: '0318-1234567', contact: '张主管' }
], visits: [] };
r = await api('/ledger', { method: 'PUT', body: { scope: 'sensw', data: sensData } }, tk);
check('超管为受限户写入台账', r.ok === true, JSON.stringify(r));

r = await api('/auth/login', { method: 'POST', body: { username: 'sensw', password: 'Sens@123' } });
const swk = r.data.token;
check('登录响应里 hideSensitive 为 true', r.data.user.hideSensitive === true, JSON.stringify(r.data.user));
r = await api('/ledger', { method: 'GET' }, swk);
check('/api/ledger 返回的当前用户 hideSensitive 仍为 true（不得被二次映射丢失）',
  r.data.user.hideSensitive === true, JSON.stringify(r.data.user));
r = await api('/auth/me', { method: 'GET' }, swk);
check('/api/auth/me 返回的当前用户 hideSensitive 仍为 true', r.data.user.hideSensitive === true, JSON.stringify(r.data.user));
check('/api/auth/me 保留 createdAt / mustChange 字段',
  /^\d{4}-\d{2}-\d{2}$/.test(String(r.data.user.createdAt)) && typeof r.data.user.mustChange === 'boolean',
  JSON.stringify({ c: r.data.user.createdAt, m: r.data.user.mustChange }));
r = await api('/ledger', { method: 'GET' }, swk);
const swC = r.data.ledgers.sensw.customers[0];
check('受限户仍可见完整详细地址', swC.addr === '河北省衡水市桃城区人民东路528号', swC.addr);
check('受限户拿到的是全隐联系人', swC.contact === '****', swC.contact);
check('受限户拿到的是全隐电话', swC.phone === '****', swC.phone);

/* 受限户把打码数据原样 PUT 回去 → 库内必须是原值 */
r = await api('/ledger', { method: 'PUT', body: { scope: 'sensw', data: r.data.ledgers.sensw } }, swk);
check('受限户写台账成功', r.ok === true, JSON.stringify(r));
r = await api('/ledger', { method: 'GET' }, tk);
const admC = r.data.ledgers.sensw.customers[0];
check('打码串未写回：库内地址仍为原值', admC.addr === '河北省衡水市桃城区人民东路528号', admC.addr);
check('打码串未写回：库内联系人仍为原值', admC.contact === '张主管', admC.contact);
check('打码串未写回：库内电话仍为原值', admC.phone === '0318-1234567', admC.phone);

/* 取消隐藏 → 立即恢复明文 */
r = await api('/users/sensw', { method: 'PATCH', body: { hideSensitive: false } }, tk);
check('PATCH 关闭隐藏敏感', r.ok === true && r.data.user.hideSensitive === false, JSON.stringify(r.data && r.data.user));
r = await api('/auth/login', { method: 'POST', body: { username: 'sensw', password: 'Sens@123' } });
r = await api('/ledger', { method: 'GET' }, r.data.token);
check('关闭后受限户看到明文地址', r.data.ledgers.sensw.customers[0].addr === '河北省衡水市桃城区人民东路528号',
  r.data.ledgers.sensw.customers[0].addr);

/* ================= CRM（询盘云）台账关联 ================= */
/* 1) 用户级中文名 + 可见开关（默认关闭，超管可开） */
r = await api('/users', { method: 'POST', body: { username: 'crmu', name: '河北片区', password: 'Crm@12345' } }, tk);
check('新建用户默认 CRM 不可见', r.ok && r.data.user.crmVisible === false, JSON.stringify(r.data && r.data.user));
check('新建用户中文名默认空', r.ok && r.data.user.nameCn === '', JSON.stringify(r.data && r.data.user.nameCn));
r = await api('/users/crmu', { method: 'PATCH', body: { nameCn: '潘超', crmVisible: true } }, tk);
check('PATCH 保存中文名', r.ok && r.data.user.nameCn === '潘超', JSON.stringify(r.data && r.data.user));
check('PATCH 保存 CRM 可见开关', r.ok && r.data.user.crmVisible === true);
r = await api('/auth/login', { method: 'POST', body: { username: 'crmu', password: 'Crm@12345' } });
const crk = r.data.token;
check('登录 bundle 带 nameCn / crmVisible', r.data.user.nameCn === '潘超' && r.data.user.crmVisible === true);
/* 给该账号建两家客户，并写入三条 CRM 快照（自己负责 / 别人负责 / 别家客户） */
r = await api('/ledger', { method: 'PUT', body: { scope: 'crmu', data: {
  regions: [], visits: [], customers: [{ id: 'x1', name: '承德银行' }, { id: 'x2', name: '衡水银行' }]
} } }, crk);
check('CRM 测试账号台账写入成功', r.ok === true, JSON.stringify(r));
db.prepare('INSERT INTO crm_matches (customer_name,status,record_id,level,multi,data,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('承德银行', 'ok', '2683492002290513', 1, 0,
    JSON.stringify({ opp: { '项目名称': '技术专用-承德银行GSLB扩容', '客户名称': '承德银行', '维护人A': '潘超' },
      maintenance: [{ serialNo: 'T5100S-001', end: '2025/11/09' }],
      warranty: { status: 'expired', total: 1, known: 1, expired: 1 } }), '2026-11-05T09:00:00.000Z');
db.prepare('INSERT INTO crm_matches (customer_name,status,record_id,level,multi,data,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('衡水银行', 'ok', '2690000000000001', 1, 0,
    JSON.stringify({ opp: { '项目名称': '技术专用-衡水银行', '客户名称': '衡水银行', '维护人A': '季荣成' },
      maintenance: [], warranty: null }), '2026-11-05T09:00:00.000Z');
db.prepare('INSERT INTO crm_matches (customer_name,status,record_id,level,multi,data,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('别家客户', 'ok', '999', 2, 0, JSON.stringify({ opp: { '客户名称': '别家客户' }, maintenance: [], warranty: null }), '2026-11-05T09:00:00.000Z');

r = await api('/crm/data', { method: 'GET' }, crk);
check('可见账号能读到 CRM 快照', r.ok && r.data.crmVisible === true, JSON.stringify(r.data));
check('只下发自己台账里的客户（不能越权看到别家）',
  !!r.data.matches['承德银行'] && !r.data.matches['别家客户'], Object.keys(r.data.matches).join(','));
check('快照含商机与维保三态', r.data.matches['承德银行'].opp['维护人A'] === '潘超' &&
  r.data.matches['承德银行'].warranty.status === 'expired');
check('/crm/data 回传中文名（前端「我负责的项目」用）', r.data.nameCn === '潘超', r.data.nameCn);

/* 关闭可见 → 仍下发「维护人A = 本人」的项目（我负责的项目对全员开放），其余隐藏 */
await api('/users/crmu', { method: 'PATCH', body: { crmVisible: false } }, tk);
r = await api('/crm/data', { method: 'GET' }, crk);
check('关闭可见后仍回「我负责的项目」',
  r.ok && r.data.crmVisible === false && r.data.mineOnly === true && !!r.data.matches['承德银行'],
  JSON.stringify({ v: r.data.crmVisible, keys: Object.keys(r.data.matches) }));
check('关闭可见后隐藏别人负责的项目',
  !r.data.matches['衡水银行'] && !r.data.matches['别家客户'], Object.keys(r.data.matches).join(','));

/* 2) 普通用户无权访问 CRM 管理接口 */
r = await api('/crm/config', { method: 'GET' }, crk);
check('普通用户读 CRM 配置 → 403', r.ok === false && r.status === 403, String(r.status));
r = await api('/crm/config', { method: 'PUT', body: { loginName: 'x', password: 'y' } }, crk);
check('普通用户改 CRM 配置 → 403', r.ok === false && r.status === 403, String(r.status));
r = await api('/crm/status', { method: 'GET' }, crk);
check('普通用户看检索状态 → 403', r.ok === false && r.status === 403, String(r.status));
r = await api('/crm/stat/meta', { method: 'GET' }, crk);
check('普通用户看区域统计 → 403', r.ok === false && r.status === 403, String(r.status));
r = await api('/crm/stat/run', { method: 'POST', body: { region: '金融行业部' } }, crk);
check('普通用户触发区域统计 → 403', r.ok === false && r.status === 403, String(r.status));

/* 2b) 授予「可见区域统计」：能读，但仍不能触发检索（只读） */
await api('/users/crmu', { method: 'PATCH', body: { statVisible: true } }, tk);
r = await api('/crm/stat/meta', { method: 'GET' }, crk);
check('授权后可读区域统计 meta', r.ok === true, r.ok ? '' : r.error);
r = await api('/crm/stat/data?region=' + encodeURIComponent('金融行业部'), { method: 'GET' }, crk);
check('授权后可读区域统计明细', r.ok === true, r.ok ? '' : r.error);
r = await api('/crm/stat/status', { method: 'GET' }, crk);
check('授权后可读区域统计进度', r.ok === true, r.ok ? '' : r.error);
r = await api('/crm/stat/run', { method: 'POST', body: { region: '金融行业部' } }, crk);
check('授权账号仍不能触发检索 → 403', r.ok === false && r.status === 403, String(r.status));
await api('/users/crmu', { method: 'PATCH', body: { statVisible: false } }, tk);
r = await api('/crm/stat/meta', { method: 'GET' }, crk);
check('收回授权后区域统计 → 403', r.ok === false && r.status === 403, String(r.status));

/* 3) 超管配置：密码只存不回显 */
r = await api('/crm/config', { method: 'PUT', body: { loginName: '13800000000', password: 'Crm@12345', intervalHours: 6 } }, tk);
check('超管保存 CRM 配置', r.ok && r.data.configured === true, JSON.stringify(r));
r = await api('/crm/config', { method: 'GET' }, tk);
check('配置回读账号与间隔', r.ok && r.data.loginName === '13800000000' && r.data.intervalHours === 6, JSON.stringify(r.data));
check('配置接口不回显密码', r.ok && r.data.password === undefined, JSON.stringify(Object.keys(r.data)));
r = await api('/crm/config', { method: 'PUT', body: { loginName: '13800000000', intervalHours: 0 } }, tk);
check('间隔非法时回退到原值（不写成 0）', r.ok && r.data.configured === true);

/* 4) 检索状态列表：按台账客户逐个给出结果 */
r = await api('/crm/status', { method: 'GET' }, tk);
check('状态接口返回客户级条目', r.ok && Array.isArray(r.data.items) && r.data.items.length > 0,
  r.ok ? String((r.data.items || []).length) : r.error);
const st = (r.data.items || []).filter(x => x.name === '承德银行')[0];
check('状态条目带匹配结果与维保三态', !!st && st.status === 'ok' && st.level === 1 &&
  st.warranty && st.warranty.status === 'expired', JSON.stringify(st));

/* 5) 超管读 /crm/data：不受可见开关限制，且能看到全部客户 */
r = await api('/crm/data', { method: 'GET' }, tk);
check('超管始终可见 CRM 数据', r.ok && r.data.crmVisible === true);
check('超管可见所有客户快照', !!r.data.matches['承德银行'] && !!r.data.matches['别家客户'],
  Object.keys(r.data.matches).join(','));

/* 6) 区域统计：超管可读元信息 / 未统计区域回 found=false / 缺区域名报错 */
r = await api('/crm/stat/meta', { method: 'GET' }, tk);
check('超管读区域统计元信息（战区列表 + 缓存）',
  r.ok && Array.isArray(r.data.regions) && Array.isArray(r.data.cached), JSON.stringify(r.data));
r = await api('/crm/stat/data?region=' + encodeURIComponent('金融行业部'), { method: 'GET' }, tk);
check('未统计过的区域回 found=false', r.ok && r.data.found === false, JSON.stringify(r.data));
r = await api('/crm/stat/run', { method: 'POST', body: { region: '' } }, tk);
check('区域统计缺区域名 → 400', r.ok === false && r.status === 400, String(r.status));

console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
process.exit(fail ? 1 : 0);
