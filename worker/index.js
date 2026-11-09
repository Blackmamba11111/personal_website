/* ============================================================================
 * 客户巡检台账 · 服务端
 * 部署形态：Cloudflare Workers 静态资源 + D1（SQLite）
 * 路由约定：/api/* 由本脚本处理；其余请求交给静态资源（env.ASSETS）
 * 鉴权：Bearer Token（存 sessions 表，按用户配置的登录超时滑动过期，默认 30 分钟）
 *
 * 账号口令有两种来源（users.source）：
 *   local  —— 盐 + 400 轮 SHA-256，存在本库
 *   radius / tacacs / ldap —— 转发给管理员配置的认证服务器校验，本库只存绑定关系
 * 协议编解码复用 worker/auth-protocols.mjs（与内部部署版同一份代码）。
 * 注意：Workers 没有 UDP 出网能力，RADIUS 在公网站点不可用，会返回明确提示。
 * ==========================================================================*/

import * as AUTH_P from './auth-protocols.mjs';
import * as CRM_P from './crm-client.mjs';

const HASH_ROUNDS = 400;

/* 认证服务器默认端口 / 展示名 */
const AUTH_TYPES = ['radius', 'tacacs', 'ldap'];
const AUTH_DEFAULT_PORT = { radius: 1812, tacacs: 49, ldap: 389 };
const AUTH_LABEL = { local: '本地', radius: 'RADIUS', tacacs: 'TACACS+', ldap: 'LDAP' };

/* 高德地图 Key（Web 服务 + JS API 同一 Key，页面已公开，此处仅作服务端默认值；
   可用 Worker 环境变量 AMAP_KEY 覆盖）。restapi.amap.com 不返回跨域头，
   地点检索必须由服务端代理转发。 */
const DEFAULT_AMAP_KEY = '96eb5c271c76440bcb9a15ed493fa350';
function amapErrMsg(infocode, info) {
  const code = String(infocode || '');
  if (code === '10009') return '高德 Key 与服务类型不匹配（USERKEY_PLAT_NOMATCH），请在高德控制台确认 Key 类型';
  if (code === '10003') return '高德 Key 请求过多，已超出每日配额，请明日再试或在控制台提升配额';
  if (code === '10021' || code === '10044') return '高德检索服务今日配额已用尽，请明天再试或在控制台提升配额';
  if (code === '10008') return '高德 Key 非法或已过期，请联系管理员在高德开放平台检查';
  if (code === '10019') return '高德请求过于频繁，请稍候几秒重试';
  if (code === '20003') return '高德服务访问量超限，请稍后重试';
  return '高德检索服务出错（' + (code || '未知') + (info ? ' ' + info : '') + '），请稍后重试';
}

/* ---------------- 基础工具 ---------------- */
function jres(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
function ok(data) { return jres({ ok: true, data: data === undefined ? null : data }); }
function bad(msg, status) { return jres({ ok: false, error: msg || '请求无效' }, status || 400); }

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
  return out;
}
/* 与前端保持同一算法：salt|pwd 起手，迭代 400 轮 */
async function hashPwd(pwd, salt) {
  let x = String(salt) + '|' + String(pwd);
  for (let i = 0; i < HASH_ROUNDS; i++) x = await sha256Hex(x + '#' + i + '|' + salt);
  return x;
}
function randHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
  return s;
}
function newSalt() { return 'S' + randHex(8); }
function newToken() { return randHex(24); }
function nowIso() { return new Date().toISOString(); }

/* 认证来源：local = 本地口令；radius / tacacs / ldap = 由对应认证服务器校验
   perm：rw = 读写；ro = 只读（可看可导出，不能改台账） */
/* 注意：本函数必须对「数据库行」和「已映射的对象」都成立——
   currentUser() 返回的已是映射对象，bundleFor() 里再次 mapUser 时若只读下划线列名，
   hide_sensitive / must_change / created_at 等会全部丢失（曾导致隐藏账号在前端被判为
   「可见」而重新画出眼睛）。因此这里统一做两种字段名的兼容。 */
function mapUser(row, srvMap) {
  row = row || {};
  const source = row.source || 'local';
  const sid = row.server_id || row.serverId || '';
  const srv = (sid && srvMap) ? srvMap[sid] : null;
  return {
    id: row.username,
    username: row.username,
    name: row.name,
    role: row.role,
    status: row.status,
    note: row.note || '',
    mustChange: row.must_change != null ? !!row.must_change : !!row.mustChange,
    createdAt: String(row.created_at || row.createdAt || '').slice(0, 10),
    lastLogin: row.last_login || row.lastLogin || '',
    source: source,
    perm: row.perm === 'ro' ? 'ro' : 'rw',
    serverId: sid,
    serverName: srv ? srv.name : (sid ? '（认证服务器已删除）' : ''),
    serverType: srv ? srv.type : (sid ? '' : source),
    shareFrom: row.share_from != null ? row.share_from : (row.shareFrom || ''),
    sessionMins: normSessionMins(row.session_mins != null ? row.session_mins : row.sessionMins),
    hideSensitive: row.hide_sensitive != null ? !!row.hide_sensitive : !!row.hideSensitive,
    nameCn: row.name_cn != null ? row.name_cn : (row.nameCn || ''),
    crmVisible: row.crm_visible != null ? !!row.crm_visible : !!row.crmVisible,
    statVisible: row.stat_visible != null ? !!row.stat_visible : !!row.statVisible,
    multiLedger: row.multi_ledger != null ? !!row.multi_ledger : !!row.multiLedger
  };
}
function normName(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function validUsername(u) { return /^[A-Za-z0-9_.-]{3,32}$/.test(u); }
const USER_COLS = 'username, name, role, status, note, must_change, created_at, last_login, source, perm, server_id, share_from, session_mins, hide_sensitive, name_cn, crm_visible, stat_visible, multi_ledger';

/* 登录超时（分钟）：按用户配置，默认 30，范围 5 ~ 43200（30 天）。
   会话为滑动过期：每次通过鉴权的请求都会把过期时间顺延到 now + session_mins。 */
function normSessionMins(v) {
  if (v === '' || v == null) return 30;
  const n = Math.round(Number(v));
  if (!isFinite(n)) return 30;
  return Math.min(43200, Math.max(5, n));
}

/* ---------------- 表结构迁移（幂等，每实例只跑一次） ---------------- */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const cols = [
    "ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'local'",
    "ALTER TABLE users ADD COLUMN perm TEXT NOT NULL DEFAULT 'rw'",
    "ALTER TABLE users ADD COLUMN server_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN share_from TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE users ADD COLUMN session_mins INTEGER NOT NULL DEFAULT 30',
    'ALTER TABLE users ADD COLUMN hide_sensitive INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE users ADD COLUMN name_cn TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE users ADD COLUMN crm_visible INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN stat_visible INTEGER NOT NULL DEFAULT 0',
    /* 多台账权限（2026-11-09）：仅对「已设共享来源」的账号有意义——开了才有第二份
       属于自己的台账，键为 `<用户名>::mine`，与他人共享的那份互不影响 */
    'ALTER TABLE users ADD COLUMN multi_ledger INTEGER NOT NULL DEFAULT 0'
  ];
  for (const sql of cols) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 列已存在 */ }
  }
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS crm_config (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS crm_matches (customer_name TEXT PRIMARY KEY, status TEXT NOT NULL, ' +
      "record_id TEXT NOT NULL DEFAULT '', level INTEGER NOT NULL DEFAULT 0, multi INTEGER NOT NULL DEFAULT 0, " +
      "data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL)"
    ).run();
    /* 区域统计（2026-11-06）：结果按战区缓存；state 用于公网分批续跑（子请求上限） */
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS crm_stat (region TEXT PRIMARY KEY, updated_at TEXT NOT NULL, ' +
      "data TEXT NOT NULL DEFAULT '{}')"
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS crm_stat_state (region TEXT PRIMARY KEY, updated_at TEXT NOT NULL, ' +
      "data TEXT NOT NULL DEFAULT '{}')"
    ).run();
    /* 明细分片：大战区（东部战区 6000+ 项目）设备上万台，D1 单行 1MB 放不下 */
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS crm_stat_chunk (region TEXT NOT NULL, idx INTEGER NOT NULL, ' +
      "data TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (region, idx))"
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS auth_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, ' +
      'host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, ' +
      'cfg TEXT NOT NULL DEFAULT \'{}\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT \'\')'
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ledger_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, ' +
      'actor TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT \'\', ' +
      'detail TEXT NOT NULL DEFAULT \'\', at TEXT NOT NULL)'
    ).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ledger_logs_owner ON ledger_logs(username, at)').run();
  } catch (e) { /* 只读或 DDL 受限时忽略 */ }
  schemaReady = true;
}

/* ---------------- 认证服务器（远程用户） ---------------- */
function parseCfg(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(String(v || '{}')) || {}; } catch (e) { return {}; }
}
async function serversMap(env) {
  const out = {};
  try {
    const r = await env.DB.prepare('SELECT * FROM auth_servers').all();
    (r.results || []).forEach(function (row) { out[row.id] = row; });
  } catch (e) { /* 表尚未建立时按「没有服务器」处理 */ }
  return out;
}
/* cfg 里可能含共享密钥：只回传非敏感项 + hasSecret 标记 */
function serverView(row, userCount) {
  const cfg = parseCfg(row.cfg);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.host,
    port: row.port || AUTH_DEFAULT_PORT[row.type] || 0,
    enabled: !!row.enabled,
    createdAt: (row.created_at || '').slice(0, 10),
    updatedAt: row.updated_at || '',
    userCount: userCount || 0,
    hasSecret: !!String(cfg.secret || ''),
    cfg: {
      timeout: cfg.timeout || 5,
      nasId: cfg.nasId || '',
      plain: cfg.plain ? 1 : 0,
      bindPattern: cfg.bindPattern || '',
      bindDn: cfg.bindDn || '',
      baseDn: cfg.baseDn || '',
      userAttr: cfg.userAttr || '',
      tls: cfg.tls ? 1 : 0,
      verifyTls: cfg.verifyTls ? 1 : 0
    },
    hasBindPwd: !!String(cfg.bindPassword || '')
  };
}
async function listServers(env) {
  const counts = {};
  try {
    const r = await env.DB.prepare("SELECT server_id, COUNT(*) AS n FROM users WHERE server_id <> '' GROUP BY server_id").all();
    (r.results || []).forEach(function (row) { counts[row.server_id] = row.n; });
  } catch (e) {}
  const r2 = await env.DB.prepare('SELECT * FROM auth_servers ORDER BY created_at').all();
  return (r2.results || []).map(function (row) { return serverView(row, counts[row.id] || 0); });
}
function canWriteUser(u) { return u.role === 'admin' || (u.perm !== 'ro'); }

/* 入参校验：返回 { err } 或 { row }（secret 未传时沿用旧值） */
function ensureServerInput(body, base) {
  body = body || {};
  const type = String(body.type || (base && base.type) || '').toLowerCase();
  if (AUTH_TYPES.indexOf(type) < 0) return { err: '认证类型需为 RADIUS / TACACS+ / LDAP 之一' };

  const name = body.name == null ? (base ? base.name : '') : String(body.name).trim();
  if (!name) return { err: '请填写认证服务器名称' };
  if (name.length > 40) return { err: '名称请控制在 40 个字符以内' };

  const host = body.host == null ? (base ? base.host : '') : String(body.host).trim();
  if (!host) return { err: '请填写服务器地址（IP 或主机名）' };
  if (!/^[A-Za-z0-9_.:\-\[\]]{1,120}$/.test(host)) return { err: '服务器地址格式不正确，只填 IP 或主机名（不要带协议和斜杠）' };

  let port = body.port == null ? (base ? base.port : 0) : parseInt(body.port, 10);
  if (!isFinite(port) || port <= 0 || port > 65535) port = AUTH_DEFAULT_PORT[type] || 0;

  const enabled = body.enabled == null ? (base ? (base.enabled ? 1 : 0) : 1) : (body.enabled ? 1 : 0);
  const oldCfg = base ? parseCfg(base.cfg) : {};
  const inCfg = parseCfg(body.cfg);
  const pick = function (k, dft) { return inCfg[k] == null ? (oldCfg[k] == null ? dft : oldCfg[k]) : inCfg[k]; };

  const cfg = {
    timeout: Math.min(30, Math.max(1, parseInt(pick('timeout', 5), 10) || 5)),
    nasId: String(pick('nasId', '') || '').slice(0, 60),
    plain: pick('plain', 0) ? 1 : 0,
    bindPattern: String(pick('bindPattern', '') || '').slice(0, 300),
    bindDn: String(pick('bindDn', '') || '').slice(0, 300),
    bindPassword: String(inCfg.bindPassword === undefined ? (oldCfg.bindPassword || '') : inCfg.bindPassword).slice(0, 200),
    baseDn: String(pick('baseDn', '') || '').slice(0, 300),
    userAttr: String(pick('userAttr', '') || '').slice(0, 40),
    tls: pick('tls', 0) ? 1 : 0,
    verifyTls: pick('verifyTls', 0) ? 1 : 0,
    secret: String(inCfg.secret === undefined ? (oldCfg.secret || '') : inCfg.secret).slice(0, 200)
  };
  if (type !== 'ldap' && !cfg.secret) return { err: 'RADIUS / TACACS+ 需要填写共享密钥（secret）' };
  if (type === 'ldap' && cfg.bindDn && cfg.bindPassword && !cfg.baseDn) {
    return { err: 'LDAP 服务账号模式需要同时填写 Base DN（作为搜索起点）' };
  }
  if (type === 'ldap' && cfg.tls && port === AUTH_DEFAULT_PORT.ldap) port = 636;

  return { row: { name: name, type: type, host: host, port: port, enabled: enabled, cfg: JSON.stringify(cfg) } };
}

/* ---------------- 远程认证：传输层（Workers 只有 TCP） ---------------- */
/* RADIUS 走 UDP，Workers 不支持 → 直接给出明确提示，而不是让管理员对着超时排查 */
let workerTcpCache;
async function workerTcp(host, port, opts) {
  opts = opts || {};
  let connect = workerTcpCache;
  if (!connect) {
    const mod = await import('cloudflare:sockets');
    connect = mod.connect;
    workerTcpCache = connect;
  }
  const sock = connect({ hostname: host, port: port, secureTransport: opts.tls ? 'on' : 'off' });
  const writer = sock.writable.getWriter();
  const reader = sock.readable.getReader();
  let chunk = new Uint8Array(0);
  let pending = null;
  let dead = null;

  function flush() {
    if (!pending || chunk.length < pending.n) return;
    const p = pending; pending = null;
    const out = chunk.slice(0, p.n);
    chunk = chunk.slice(p.n);
    p.resolve(out);
  }
  (async function pump() {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) { dead = new Error('连接已被服务器关闭'); break; }
        const v = r.value;
        const merged = new Uint8Array(chunk.length + v.length);
        merged.set(chunk); merged.set(v, chunk.length);
        chunk = merged;
        flush();
      }
    } catch (e) { dead = e; }
    if (pending) { pending.reject(dead || new Error('连接已关闭')); pending = null; }
  })();

  function withTimeout(promise, ms, what) {
    return Promise.race([promise, new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error((what || '操作') + '超时')); }, ms);
    })]);
  }
  const ms = opts.timeoutMs || 5000;
  return {
    write: function (bytes) { return withTimeout(writer.write(bytes), ms, '发送'); },
    read: function (n) {
      if (chunk.length >= n) {
        const out = chunk.slice(0, n); chunk = chunk.slice(n);
        return Promise.resolve(out);
      }
      if (dead) return Promise.reject(dead);
      return withTimeout(new Promise(function (res, rej) { pending = { n: n, resolve: res, reject: rej }; }), ms, '读取响应');
    },
    close: function () { try { reader.cancel(); } catch (e) {} try { writer.close(); } catch (e) {} }
  };
}

const AUTH_TRANSPORT = {
  udp: null,   /* Workers 无 UDP：RADIUS 会由协议层返回 unsupported */
  tcp: function (host, port, opts) { return workerTcp(host, port, opts); }
};

async function remoteAuth(srv, username, password) {
  return AUTH_P.authenticate(AUTH_TRANSPORT, {
    type: srv.type, host: srv.host, port: srv.port || AUTH_DEFAULT_PORT[srv.type] || 0,
    cfg: parseCfg(srv.cfg)
  }, username, password);
}

/* ---------------- 会话 ---------------- */
async function currentUser(env, request) {
  const raw = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const token = m[1].trim();
  const row = await env.DB.prepare(
    'SELECT s.expires_at AS exp, u.username, u.name, u.role, u.status, u.note, u.must_change, u.created_at, u.last_login, ' +
    'u.source, u.perm, u.server_id, u.share_from, u.session_mins, u.hide_sensitive, u.name_cn, u.crm_visible, u.stat_visible, u.multi_ledger ' +
    'FROM sessions s JOIN users u ON u.username = s.username WHERE s.token = ?'
  ).bind(token).first();
  if (!row) return null;
  const mins = normSessionMins(row.session_mins);
  const expMs = Date.parse(row.exp);
  if (expMs < Date.now()) {
    try { await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run(); } catch (e) {}
    return null;
  }
  /* 滑动续期：剩余时间不足半个周期时，把过期时间顺延到 now + session_mins（减少写库次数） */
  if (expMs - Date.now() < mins * 30000) {
    try {
      await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
        .bind(new Date(Date.now() + mins * 60000).toISOString(), token).run();
    } catch (e) { /* 续期失败不影响本次请求 */
    }
  }
  if (row.status !== 'active') return null;
  const u = mapUser(row, await serversMap(env));
  u.token = token;
  return u;
}

/* ---------------- 数据读写（共享数据集：share_from 指向数据归属者，一层） ----------------
 * 多台账（2026-11-09）：multi_ledger=1 且**处在共享关系里**的非超管账号，额外拥有一份
 * **属于自己的**台账，存放在同一张 ledgers 表里，键为 `<用户名>::mine`。
 *   · 公共台账 key = share_from（借来的那份；自己就是提供方时 key = 自己，与他人双向同步）
 *   · 个人台账 key = `<用户名>::mine`（只有本人与超管可见，恒可写）
 * 「处在共享关系里」两种都算：① 我借了别人的台账（share_from 指向他人）；② 别人借了我的
 * 台账（有下家 share_from 指向我）。纯独立账号没有第二份台账，行为与旧版完全一致。
 * 只有显式传 mine 才落到个人台账，未开权限 / 不在共享关系里时 mine 被忽略。 */
const MINE_SUFFIX = '::mine';
function mineKey(username) { return String(username || '') + MINE_SUFFIX; }
function multiFlagOf(u) {
  return u.multiLedger != null ? u.multiLedger : u.multi_ledger;
}
/* 该账号是否已经把台账共享给别人（有下家 share_from 指向它） */
async function hasSharedTo(env, username) {
  const r = await env.DB.prepare('SELECT 1 AS x FROM users WHERE share_from = ? LIMIT 1').bind(username).first();
  return !!r;
}
/* 该用户是否真的拥有第二份台账：开关 + 非超管 + 共享关系（借入 / 借出，任一即可）。
   注意：bundleFor 与请求上下文可能拿到「数据库行」（下划线）或「已映射对象」（驼峰），两种都要认 */
async function hasMultiLedger(env, u) {
  if (!u || u.role === 'admin') return false;
  if (!multiFlagOf(u)) return false;
  if (u.shareFrom != null ? u.shareFrom : u.share_from) return true;
  const down = u.sharedWith;                        /* bundleFor 已算好的下家清单，省一次查询 */
  if (Array.isArray(down)) return down.length > 0;
  return hasSharedTo(env, u.username);
}
async function dataOwner(env, username) {
  const row = await env.DB.prepare('SELECT share_from FROM users WHERE username = ?').bind(username).first();
  return (row && row.share_from) ? row.share_from : username;
}
/* 台账真正落库的键：mine=true 且权限成立时用个人键，否则沿用共享归属者 */
async function ledgerKeyOf(env, username, mine) {
  if (mine) {
    const row = await env.DB.prepare(
      'SELECT share_from, multi_ledger, role, ' +
      '(SELECT COUNT(*) FROM users x WHERE x.share_from = users.username) AS down ' +
      'FROM users WHERE username = ?'
    ).bind(username).first();
    if (row && row.multi_ledger && row.role !== 'admin' && (row.share_from || row.down)) return mineKey(username);
  }
  return dataOwner(env, username);
}
async function shareMembers(env, owner) {
  const r = await env.DB.prepare('SELECT username FROM users WHERE share_from = ? ORDER BY created_at').bind(owner).all();
  return (r.results || []).map(function (x) { return x.username; });
}
async function readLedger(env, username, mine) {
  const owner = await ledgerKeyOf(env, username, mine);
  const row = await env.DB.prepare('SELECT data FROM ledgers WHERE username = ?').bind(owner).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (e) { return null; }
}

/* ---------------- CRM（询盘云/销售易）台账关联 ----------------
 * 协议实现在 ./crm-client.mjs（与内部部署版共用同一份）。
 * 公网按用户约定「代码与内网一致」：配置齐全则定时检索可用，未配置则闲置。 */
const CRM_DEFAULT_INTERVAL = 12;
async function readCrmConfig(env) {
  const row = await env.DB.prepare("SELECT v FROM crm_config WHERE k = 'main'").first();
  if (!row) return { loginName: '', password: '', intervalHours: CRM_DEFAULT_INTERVAL, lastSyncAt: '', lastResult: null, session: null };
  try {
    const v = JSON.parse(row.v) || {};
    return {
      loginName: v.loginName || '', password: v.password || '',
      intervalHours: Number(v.intervalHours) > 0 ? Number(v.intervalHours) : CRM_DEFAULT_INTERVAL,
      lastSyncAt: v.lastSyncAt || '', lastResult: v.lastResult || null, session: v.session || null
    };
  } catch (e) { return { loginName: '', password: '', intervalHours: CRM_DEFAULT_INTERVAL, lastSyncAt: '', lastResult: null, session: null }; }
}
async function saveCrmConfig(env, cfg) {
  await env.DB.prepare("INSERT INTO crm_config (k, v) VALUES ('main', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(JSON.stringify(cfg)).run();
}
async function crmConfigured(env) {
  const c = await readCrmConfig(env);
  return !!(c.loginName && c.password);
}
/* 全库客户名去重（所有台账 owner 的 customers[].name） */
async function collectCustomerNames(env) {
  const names = {};
  const r = await env.DB.prepare(
    'SELECT username, share_from, multi_ledger, ' +
    '(SELECT COUNT(*) FROM users x WHERE x.share_from = users.username) AS down FROM users'
  ).all();
  for (const row of (r.results || [])) {
    const d = await readLedger(env, row.username);
    if (d && Array.isArray(d.customers)) {
      d.customers.forEach(function (c) { if (c && c.name) names[c.name] = true; });
    }
    /* 多台账账号的个人台账里也可能有公共台账没有的客户，同样要参与 CRM 匹配 */
    if (row.multi_ledger && (row.share_from || row.down)) {
      const p = await readLedger(env, row.username, true);
      if (p && Array.isArray(p.customers)) {
        p.customers.forEach(function (c) { if (c && c.name) names[c.name] = true; });
      }
    }
  }
  return Object.keys(names);
}
async function upsertCrmMatch(env, name, r) {
  const at = new Date().toISOString();
  if (r.status !== 'ok') {
    await env.DB.prepare(
      'INSERT INTO crm_matches (customer_name, status, record_id, level, multi, data, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?) ' +
      'ON CONFLICT(customer_name) DO UPDATE SET status = excluded.status, record_id = excluded.record_id, level = 0, multi = 0, data = excluded.data, updated_at = excluded.updated_at'
    ).bind(name, 'miss', '', JSON.stringify({ error: r.error || null }), at).run();
    return;
  }
  await env.DB.prepare(
    'INSERT INTO crm_matches (customer_name, status, record_id, level, multi, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(customer_name) DO UPDATE SET status = excluded.status, record_id = excluded.record_id, level = excluded.level, multi = excluded.multi, data = excluded.data, updated_at = excluded.updated_at'
  ).bind(name, 'ok', String(r.opp.id || ''), r.level || 1, r.multi ? 1 : 0,
    JSON.stringify({
      opp: r.opp.f, projects: r.projects || [], maintenance: r.maintenance || [],
      warranty: r.warranty || null, error: r.error || null,
    }), at).run();
}
/* 跑一轮完整同步（Cron scheduled 或手动触发）；Workers 单次执行有时长上限，
   客户数多时靠 12 小时间隔自然分摊，这里不做跨请求断点续跑。 */
/* ---------- 检索进度（2026-11-06）：内存即时可读，6s 节流落 D1 供其他 isolate 兜底读取 ---------- */
let crmProgressMem = null;
let crmProgressWriteAt = 0;
function crmProgressNew(reason, total) {
  const t = new Date().toISOString();
  return {
    running: true, reason: reason, stage: 'login', message: '正在登录询盘云（销售易）…',
    done: 0, total: total, current: '', oppCount: 0,
    matched: 0, missed: 0, failed: 0,
    startedAt: t, updatedAt: t, finishedAt: '', ok: null, error: '',
  };
}
function mergeCrmProgress(prog, p) {
  const src = p || {};
  ['stage', 'message', 'done', 'total', 'current', 'oppCount', 'matched', 'missed', 'failed',
    'projectIndex', 'projectTotal', 'projectName'].forEach(function (k) {
    if (src[k] !== undefined) prog[k] = src[k];
  });
  prog.updatedAt = new Date().toISOString();
}
function finishCrmProgress(prog, outcome) {
  const st = (outcome && outcome.stats) || null;
  if (st) {
    prog.done = st.total; prog.total = st.total;
    prog.matched = st.matched; prog.missed = st.missed; prog.failed = st.failed;
  }
  prog.running = false;
  prog.finishedAt = new Date().toISOString();
  prog.updatedAt = prog.finishedAt;
  prog.ok = !!(outcome && outcome.ok);
  prog.stage = prog.ok ? 'done' : 'error';
  prog.error = prog.ok ? '' : String((outcome && (outcome.message || outcome.code)) || '未知错误');
  prog.message = prog.ok
    ? ('检索完成：匹配成功 ' + prog.matched + ' / 未匹配 ' + prog.missed +
      (prog.failed ? ' / 失败 ' + prog.failed : '') + ' 个客户')
    : ('检索失败：' + prog.error);
}
async function saveCrmProgress(env, prog, force) {
  const now = Date.now();
  if (!force && now - crmProgressWriteAt < 6000) return;
  crmProgressWriteAt = now;
  try {
    await env.DB.prepare("INSERT INTO crm_config (k, v) VALUES ('progress', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .bind(JSON.stringify(prog)).run();
  } catch (e) { /* 进度落库失败不影响检索本身 */ }
}
async function readCrmProgress(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM crm_config WHERE k = 'progress'").first();
    return row ? (JSON.parse(row.v) || null) : null;
  } catch (e) { return null; }
}

async function doCrmSync(env, reason) {
  const cfg = await readCrmConfig(env);
  if (!(cfg.loginName && cfg.password)) return { ok: false, message: '未配置 CRM 账号' };
  const startedAt = new Date().toISOString();
  const names = await collectCustomerNames(env);
  const prog = crmProgressNew(reason, names.length);
  crmProgressMem = prog;
  crmProgressWriteAt = 0;
  let outcome;
  try {
    /* 不复用 cfg.session：复用旧会话时 CRM 分页会中途截断（实测只回 1344 条），
       每轮重新登录只多几秒，换取商机全量（2026-11-06） */
    outcome = await CRM_P.runCrmSync({
      loginName: cfg.loginName, password: cfg.password,
      customerNames: names,
      onMatch: async function (n, r) { await upsertCrmMatch(env, n, r); },
      onProgress: async function (p) {
        mergeCrmProgress(prog, p);
        await saveCrmProgress(env, prog, false);
      }
    }, { fetchImpl: fetch });
  } catch (e) {
    outcome = { ok: false, code: 'exception', message: '同步异常：' + (e && e.message) };
  }
  finishCrmProgress(prog, outcome);
  await saveCrmProgress(env, prog, true);
  cfg.lastSyncAt = startedAt;
  cfg.session = (outcome && outcome.session) || null;
  cfg.lastResult = outcome && outcome.ok
    ? { ok: true, at: new Date().toISOString(), reason: reason, stats: outcome.stats }
    : { ok: false, at: new Date().toISOString(), reason: reason, code: outcome && outcome.code, message: outcome && outcome.message };
  await saveCrmConfig(env, cfg);
  return cfg.lastResult;
}

/* ---------------- 区域统计（按战区，公网分批版，2026-11-06） ----------------
 * Workers 免费版单次约 50 个子请求，金融行业部 560 个项目不可能一轮跑完：
 *  - 首批：登录 + 字段标签 + 全量商机（约 23 个请求）→ 过滤战区 → 写 crm_stat_state
 *  - 后续每批：重新登录 + 取 STAT_BATCH 个项目的维保，写回 state
 *  - 前端轮询到 needNext=true 时再次 POST /api/crm/stat/run 续跑（不带 reset）
 * state = { st: { opps, idx, devices, regions, startedAt }, prog: {…} }
 */
const STAT_BATCH = 16;
let crmStatMem = null;

function statProgNew(region) {
  const t = new Date().toISOString();
  return {
    running: true, region: region, stage: 'login', message: '正在登录询盘云（销售易）…',
    done: 0, total: 0, current: '', needNext: false,
    startedAt: t, updatedAt: t, finishedAt: '', ok: null, error: ''
  };
}
async function readStatState(env, region) {
  try {
    const row = await env.DB.prepare('SELECT data FROM crm_stat_state WHERE region = ?').bind(region).first();
    if (!row) return null;
    return JSON.parse(row.data || '{}') || null;
  } catch (e) { return null; }
}
async function saveStatState(env, region, st, prog) {
  try {
    await env.DB.prepare('INSERT INTO crm_stat_state (region, updated_at, data) VALUES (?, ?, ?) ' +
      'ON CONFLICT(region) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data')
      .bind(region, new Date().toISOString(), JSON.stringify({ st: st, prog: prog })).run();
  } catch (e) { console.error('[crm:stat] state 保存失败：' + (e && e.message)); }
}
async function clearStatState(env, region) {
  try { await env.DB.prepare('DELETE FROM crm_stat_state WHERE region = ?').bind(region).run(); } catch (e) {}
}
async function readStatProgress(env) {
  if (crmStatMem) return crmStatMem;
  try {
    const row = await env.DB.prepare("SELECT v FROM crm_config WHERE k = 'stat_progress'").first();
    return row ? (JSON.parse(row.v) || null) : null;
  } catch (e) { return null; }
}
async function setStatProgress(env, prog) {
  crmStatMem = prog;
  try {
    await env.DB.prepare("INSERT INTO crm_config (k, v) VALUES ('stat_progress', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .bind(JSON.stringify(prog)).run();
  } catch (e) {}
}
async function readStatRegions(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM crm_config WHERE k = 'stat_regions'").first();
    const arr = row ? JSON.parse(row.v) : null;
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (e) {}
  return [];
}

/* 跑一批（约 STAT_BATCH 个项目）；reset=true 表示从拉商机重新开始 */
async function doRegionStatBatch(env, region, reset) {
  const cfg = await readCrmConfig(env);
  if (!(cfg.loginName && cfg.password)) return { ok: false, message: '未配置 CRM 账号' };
  const P = CRM_P;
  const nowIso2 = function () { return new Date().toISOString(); };

  let saved = reset ? null : await readStatState(env, region);
  let st = saved && saved.st ? saved.st : null;
  let prog = (saved && saved.prog) || statProgNew(region);
  prog.region = region;
  prog.running = true; prog.ok = null; prog.needNext = false;
  prog.updatedAt = nowIso2();
  if (!prog.startedAt) prog.startedAt = prog.updatedAt;

  const fail = async function (msg) {
    prog.running = false; prog.ok = false; prog.stage = 'error';
    prog.error = String(msg || '未知错误'); prog.message = '统计失败：' + prog.error;
    prog.finishedAt = nowIso2(); prog.updatedAt = prog.finishedAt; prog.needNext = false;
    await setStatProgress(env, prog);
    await clearStatState(env, region);
    return { ok: false, message: prog.error, progress: prog };
  };

  const lr = await P.xsyLogin({ loginName: cfg.loginName, password: cfg.password }, { fetchImpl: fetch });
  if (!lr.ok) return await fail(lr.message || ('登录失败 ' + (lr.code || '')));
  const session = lr.session;

  if (!st) {
    prog.stage = 'opps'; prog.message = '正在拉取 CRM 商机列表（全域）…'; prog.updatedAt = nowIso2();
    await setStatProgress(env, prog);
    const labR = await P.fetchFieldLabels(session, { fetchImpl: fetch });
    if (!labR.ok) return await fail(labR.message || '字段标签拉取失败');
    const fr = await P.fetchAllOpportunities(session, { fetchImpl: fetch, labels: labR.labels });
    if (!fr.ok) return await fail(fr.message || '商机拉取失败');
    const recs = fr.records || [];
    const regMap = {};
    recs.forEach(function (r) {
      const k = String((r.f && r.f['战区']) || '').trim() || '（未填战区）';
      regMap[k] = (regMap[k] || 0) + 1;
    });
    const regions = Object.keys(regMap).sort(function (a, b) { return regMap[b] - regMap[a]; })
      .map(function (k) { return { name: k, count: regMap[k] }; });
    if (regions.length) {
      try {
        await env.DB.prepare("INSERT INTO crm_config (k, v) VALUES ('stat_regions', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
          .bind(JSON.stringify(regions)).run();
      } catch (e) {}
    }
    const hits = recs.filter(function (r) {
      return String((r.f && r.f['战区']) || '').trim() === region;
    });
    st = {
      opps: hits.map(function (r) {
        return {
          id: r.id,
          name: String((r.f && r.f['项目名称']) || ''),
          customer: String((r.f && r.f['客户名称']) || ''),
          dept: String((r.f && r.f['所属部门']) || ''),
          owner: String((r.f && r.f['项目所有人']) || '')
        };
      }),
      idx: 0, devices: {}, regions: regions, startedAt: prog.startedAt
    };
    prog.total = st.opps.length;
    prog.done = 0;
  }

  /* 本批：逐个项目拉维保（不跨批复用会话，避免中途失效） */
  const total = st.opps.length;
  let n = 0;
  while (st.idx < total && n < STAT_BATCH) {
    const o = st.opps[st.idx];
    prog.stage = 'devices';
    prog.done = st.idx;
    prog.total = total;
    prog.current = o.name;
    prog.message = '正在拉取项目维保（' + st.idx + '/' + total + '）：' + o.name;
    prog.updatedAt = nowIso2();
    try {
      const wb = await P.fetchMaintenance(session, o.id, { fetchImpl: fetch });
      st.devices[o.id] = wb.ok ? (wb.devices || []) : [];
    } catch (e) {
      st.devices[o.id] = [];
    }
    st.idx++;
    n++;
    if (st.idx < total && n < STAT_BATCH) {
      await new Promise(function (r) { setTimeout(r, 250); });
    }
  }

  if (st.idx >= total) {
    const projects = st.opps.map(function (o) {
      return {
        id: o.id, name: o.name, customer: o.customer, dept: o.dept, owner: o.owner,
        devices: st.devices[o.id] || [], error: null
      };
    });
    const built = P.buildRegionStat(projects);
    try {
      /* 明细分片写：单分片约 60 万字符，主行只放统计与汇总，避免撞 D1 单行 1MB 上限 */
      const CHUNK_CHARS = 600000;
      const chunks = [];
      let cur = [], curLen = 0;
      built.rows.forEach(function (row) {
        const s = JSON.stringify(row);
        if (curLen + s.length > CHUNK_CHARS && cur.length) { chunks.push(cur); cur = []; curLen = 0; }
        cur.push(row); curLen += s.length + 1;
      });
      if (cur.length) chunks.push(cur);
      await env.DB.prepare('DELETE FROM crm_stat_chunk WHERE region = ?').bind(region).run();
      for (let ci = 0; ci < chunks.length; ci++) {
        await env.DB.prepare('INSERT INTO crm_stat_chunk (region, idx, data) VALUES (?, ?, ?)')
          .bind(region, ci, JSON.stringify(chunks[ci])).run();
      }
      await env.DB.prepare('INSERT INTO crm_stat (region, updated_at, data) VALUES (?, ?, ?) ' +
        'ON CONFLICT(region) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data')
        .bind(region, nowIso2(), JSON.stringify({
          stats: built.stats, summary: built.summary, chunkCount: chunks.length, truncated: false,
          projects: projects.map(function (p) {
            return {
              id: p.id, name: p.name, customer: p.customer, dept: p.dept, owner: p.owner,
              deviceCount: (p.devices || []).length, error: null
            };
          })
        })).run();
    } catch (e) {
      return await fail('统计结果写入失败（' + (e && e.message) + '）');
    }
    prog.running = false; prog.ok = true; prog.stage = 'done';
    prog.done = total; prog.total = total; prog.finishedAt = nowIso2(); prog.updatedAt = prog.finishedAt;
    prog.needNext = false;
    prog.message = '统计完成：' + built.stats.projects + ' 个项目，' + built.stats.devices +
      ' 台设备，' + built.stats.models + ' 个型号';
    await setStatProgress(env, prog);
    await clearStatState(env, region);
    return { ok: true, stats: built.stats, progress: prog };
  }

  prog.needNext = true;
  prog.message = '正在拉取项目维保（' + st.idx + '/' + total + '），继续下一批…';
  prog.updatedAt = nowIso2();
  await setStatProgress(env, prog);
  await saveStatState(env, region, st, prog);
  return { ok: true, partial: true, progress: prog };
}

/* ---------- 变更日志：新旧台账 diff 出字段级明细 ---------- */
const FIELD_LABELS = {
  name: '客户名称', regionId: '所属区域', province: '省份', city: '城市', addr: '地址',
  lng: '经度', lat: '纬度', freq: '巡检频率', contact: '联系人', phone: '联系电话', note: '备注',
  by: '巡检人', date: '巡检日期', mode: '巡检方式', result: '巡检结果'
};
function fmtVal(v) {
  if (v === undefined || v === null || v === '') return '空';
  if (Array.isArray(v)) return '[' + (v.length) + ' 个附件]';
  if (typeof v === 'object') return '…';
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}
function byId(arr) { const m = {}; (arr || []).forEach(function (x) { if (x && x.id) m[x.id] = x; }); return m; }
function diffLedgerLogs(oldD, newD) {
  const logs = [];
  oldD = oldD || { regions: [], customers: [], visits: [] };
  const cname = (d, id) => { const c = d.customers.filter(function (x) { return x.id === id; })[0]; return c ? c.name : id; };

  const oc = byId(oldD.customers), nc = byId(newD.customers);
  Object.keys(nc).forEach(function (id) {
    if (!oc[id]) { logs.push({ kind: 'customer', action: 'add', target: nc[id].name || id, detail: '' }); return; }
    const diffs = [];
    Object.keys(nc[id]).forEach(function (k) {
      if (JSON.stringify(oc[id][k]) !== JSON.stringify(nc[id][k])) {
        diffs.push((FIELD_LABELS[k] || k) + '：' + fmtVal(oc[id][k]) + ' → ' + fmtVal(nc[id][k]));
      }
    });
    if (diffs.length) logs.push({ kind: 'customer', action: 'update', target: nc[id].name || id, detail: diffs.join('；') });
  });
  Object.keys(oc).forEach(function (id) {
    if (!nc[id]) logs.push({ kind: 'customer', action: 'delete', target: oc[id].name || id, detail: '' });
  });

  const ov = byId(oldD.visits), nv = byId(newD.visits);
  Object.keys(nv).forEach(function (id) {
    const v = nv[id];
    const label = cname(newD, v.customerId) + ' · ' + (v.date || '');
    if (!ov[id]) { logs.push({ kind: 'visit', action: 'add', target: label, detail: (v.by ? '巡检人 ' + v.by : '') }); return; }
    const diffs = [];
    Object.keys(v).forEach(function (k) {
      if (JSON.stringify(ov[id][k]) !== JSON.stringify(v[k])) {
        diffs.push((FIELD_LABELS[k] || k) + '：' + fmtVal(ov[id][k]) + ' → ' + fmtVal(v[k]));
      }
    });
    if (diffs.length) logs.push({ kind: 'visit', action: 'update', target: label, detail: diffs.join('；') });
  });
  Object.keys(ov).forEach(function (id) {
    if (!nv[id]) logs.push({ kind: 'visit', action: 'delete', target: cname(oldD, ov[id].customerId) + ' · ' + (ov[id].date || ''), detail: '' });
  });

  const org = byId(oldD.regions), nrg = byId(newD.regions);
  Object.keys(nrg).forEach(function (id) {
    if (!org[id]) logs.push({ kind: 'region', action: 'add', target: nrg[id].name || id, detail: '' });
    else if (org[id].name !== nrg[id].name) {
      logs.push({ kind: 'region', action: 'update', target: nrg[id].name || id, detail: '名称：' + fmtVal(org[id].name) + ' → ' + fmtVal(nrg[id].name) });
    }
  });
  Object.keys(org).forEach(function (id) {
    if (!nrg[id]) logs.push({ kind: 'region', action: 'delete', target: org[id].name || id, detail: '' });
  });
  return logs;
}
async function writeLedger(env, username, data, by, mine) {
  const owner = await ledgerKeyOf(env, username, mine);
  const oldData = await readLedger(env, owner);
  await env.DB.prepare(
    'INSERT INTO ledgers (username, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
  ).bind(owner, JSON.stringify(data), nowIso(), by).run();
  const logs = oldData ? diffLedgerLogs(oldData, data) : [{ kind: 'init', action: 'add', target: '台账', detail: '初始化台账' }];
  if (logs.length) {
    const at = nowIso();
    for (const l of logs) {
      await env.DB.prepare(
        'INSERT INTO ledger_logs (username, actor, kind, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(owner, by, l.kind, l.action, l.target || '', l.detail || '', at).run();
    }
    /* 容量保护：每数据集最多留 2000 条 */
    try {
      await env.DB.prepare(
        'DELETE FROM ledger_logs WHERE username = ? AND id NOT IN ' +
        '(SELECT id FROM ledger_logs WHERE username = ? ORDER BY id DESC LIMIT 2000)'
      ).bind(owner, owner).run();
    } catch (e) { /* 清理失败不影响主流程 */ }
  }
}
function sanitizeLedger(d) {
  d = d || {};
  return {
    regions: Array.isArray(d.regions) ? d.regions : [],
    customers: Array.isArray(d.customers) ? d.customers : [],
    visits: Array.isArray(d.visits) ? d.visits : []
  };
}

/* ---------- 敏感字段（客户联系人 / 电话）按用户隐藏 ----------
   hide_sensitive=1 的账号：GET /api/ledger 时把客户的 contact/phone
   一律替换为 ****（全隐，不保留首尾字符）；详细地址不属于敏感项，照常下发。
   PUT 时对已存在客户回填库内原值（防止把 **** 写回破坏数据）。
   打码在服务端完成，客户端（列表 / 详情 / CSV / localStorage 镜像）全程拿不到明文。 */
const HIDDEN_TEXT = '****';
function maskLedgerSensitive(d) {
  d = d || {};
  return {
    regions: d.regions || [],
    visits: d.visits || [],
    customers: (Array.isArray(d.customers) ? d.customers : []).map(function (c) {
      if (!c) return c;
      return Object.assign({}, c, {
        contact: c.contact ? HIDDEN_TEXT : '',
        phone: c.phone ? HIDDEN_TEXT : ''
      });
    })
  };
}

/* 登录/刷新共用：组装用户可见的数据快照 */
async function bundleFor(env, u) {
  const isAdmin = u.role === 'admin';
  const srvMap = await serversMap(env);
  let users;
  if (isAdmin) {
    const r = await env.DB.prepare(
      'SELECT ' + USER_COLS + ' FROM users ORDER BY created_at'
    ).all();
    users = (r.results || []).map(function (row) { return mapUser(row, srvMap); });
  } else {
    users = [mapUser(u, srvMap)];
  }
  /* 下家清单必须先算：台账「已被共享给别人」的账号同样可以开第二份台账 */
  for (const x of users) {
    x.sharedWith = await shareMembers(env, x.username);
  }
  const meRec = users.filter(function (x) { return x.username === u.username; })[0];
  if (meRec) u.sharedWith = meRec.sharedWith;
  const multi = isAdmin ? false : await hasMultiLedger(env, u);
  const ledgers = {};
  const hideSens = !!u.hideSensitive;
  const mask = function (d) { return hideSens ? maskLedgerSensitive(d) : d; };
  if (isAdmin) {
    for (const row of users) {
      const d = await readLedger(env, row.username);   /* 共享成员解析到 owner 的数据 */
      if (d) ledgers[row.username] = mask(d);
      /* 多台账账号的个人台账：单独一个键，超管汇总时当作独立数据集各计一次 */
      if (await hasMultiLedger(env, row)) {
        const p = await readLedger(env, row.username, true);
        if (p) ledgers[mineKey(row.username)] = mask(p);
      }
    }
  } else {
    const d = await readLedger(env, u.username);
    if (d) ledgers[u.username] = mask(d);
    if (multi) {
      const p = await readLedger(env, u.username, true);
      if (p) ledgers[mineKey(u.username)] = mask(p);
    }
  }
  return {
    user: mapUser(u, srvMap), users: users, ledgers: ledgers, admin: isAdmin,
    canWrite: canWriteUser(u), attachMax: ATTACH_MAX,
    /* 当前账号的台账形态：multi=true 时前端才显示「公共 / 我的」切换 */
    ledger: {
      multi: multi,
      mineKey: mineKey(u.username),
      shareFrom: (u.shareFrom != null ? u.shareFrom : (u.share_from || '')),
      sharedTo: (u.sharedWith || []).slice()
    },
    /* 认证服务器清单只给超管（密钥仅标记是否已设置） */
    authServers: isAdmin ? await listServers(env) : []
  };
}

async function activeAdminCount(env, exclude) {
  const sql = exclude
    ? "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND username <> ?"
    : "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'";
  const st = env.DB.prepare(sql);
  const row = await (exclude ? st.bind(exclude) : st).first();
  return row ? row.n : 0;
}

/* ---------------- 巡检附件（D1 存放 base64） ---------------- */
/* D1 单行/单值上限 2MB（官方 limits），base64 膨胀 4/3，故文件上限取 1MB。
   id 为 24 位随机十六进制，读取接口公开（<img>/<iframe> 无法带 Authorization），
   但 id 不可枚举；上传/删除需登录。 */
const ATTACH_MAX = 1024 * 1024;
const ATTACH_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  /* WPS 文字（.wps/.wpt）与 RTF：前端用内置解析器预览 */
  '.wps': 'application/vnd.ms-works', '.wpt': 'application/vnd.ms-works',
  '.rtf': 'application/rtf',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.eml': 'message/rfc822'
};
const INLINE_MIME = /^(image\/(jpeg|png|webp|gif)|application\/pdf|text\/(plain|csv))/;

let attachTableReady = false;
async function ensureAttachTable(env) {
  if (attachTableReady) return;
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, ' +
      'size INTEGER NOT NULL, owner TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)'
    ).run();
    attachTableReady = true;
  } catch (e) { /* 只读或 DDL 受限时忽略，后续查询会给出明确错误 */ }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
function sniffImage(bytes) {
  if (!bytes || bytes.length < 16) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png';
  const head = String.fromCharCode.apply(null, bytes.subarray(0, 4));
  const webp = String.fromCharCode.apply(null, bytes.subarray(8, 12));
  if (head === 'RIFF' && webp === 'WEBP') return '.webp';
  return null;
}
function attachExtOf(name, mime) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  const byName = m ? ('.' + m[1]).toLowerCase() : '';
  if (ATTACH_MIME[byName]) return byName;
  const hit = Object.keys(ATTACH_MIME).filter(function (e) { return ATTACH_MIME[e].split(';')[0] === mime; })[0];
  return hit || '';
}
function safeFileName(name) {
  const base = String(name || 'file').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 120);
  return base || 'file';
}
function contentDisposition(kind, name) {
  const ascii = safeFileName(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return kind + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safeFileName(name));
}

/* ---------------- 首页照片存储 ---------------- */
/* 与内网版同一套接口（/api/photo/current、POST/DELETE /api/photo）。
   差异仅在存储介质：这里以 base64 存 D1（单行上限 2MB → 二进制上限 1.4MB，
   前端压缩后约 100KB，余量充足）。读取公开；上传/删除仅接受同源请求。 */
const PHOTO_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const PHOTO_MAX = 1400 * 1024;

let photoTableReady = false;
async function ensurePhotoTable(env) {
  if (photoTableReady) return;
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS home_photo (id INTEGER PRIMARY KEY CHECK (id = 1), ' +
      'data TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, updated_at TEXT NOT NULL)'
    ).run();
    photoTableReady = true;
  } catch (e) { /* DDL 受限时忽略，后续查询会给出明确错误 */ }
}
function sameOriginPhoto(request) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return true;
  let oh = '';
  try { oh = new URL(origin).host; } catch (e) { oh = ''; }
  return oh === new URL(request.url).host;
}

/* ---------------- 路由 ---------------- */
async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try { body = await request.json(); } catch (e) { body = {}; }
  }

  /* 老库补列 / 建认证服务器表（幂等，每实例只跑一次） */
  await ensureSchema(env);

  /* --- 登录 --- */
  if (p === '/api/auth/login' && method === 'POST') {
    const username = normName(body.username);
    const password = String(body.password || '');
    if (!username || !password) return bad('请输入用户名与密码。');
    const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    /* 账号不存在与密码错误统一提示，避免账号枚举 */
    if (!u) return bad('用户名或密码不正确。', 401);
    /* 口令来源：本地哈希，或转发给 RADIUS / TACACS+ / LDAP 服务器校验 */
    const source = u.source || 'local';
    if (source === 'local') {
      const h = await hashPwd(password, u.salt);
      if (h !== u.hash) return bad('用户名或密码不正确。', 401);
    } else {
      if (u.status !== 'active') return bad('该账号已停用，请联系超级管理员。', 403);
      const srv = await env.DB.prepare('SELECT * FROM auth_servers WHERE id = ?').bind(u.server_id || '').first();
      if (!srv || !srv.enabled) return bad('认证服务暂时不可用，请联系超级管理员。', 503);
      const r = await remoteAuth(srv, u.username, password);
      if (!r.ok) {
        if (r.code === 'reject' || r.code === 'nouser') return bad('用户名或密码不正确。', 401);
        return bad('认证服务暂时不可用（' + r.message + '），请联系超级管理员。', 502);
      }
    }
    if (u.status !== 'active') return bad('该账号已停用，请联系超级管理员。', 403);

    /* 远程账号（RADIUS/TACACS+/LDAP）的口令由认证服务器掌管，本系统不存在
       「首登改密」。历史遗留的 must_change=1 在登录时自动校正，否则登录后
       会弹出改密弹窗且该账号永远无法完成。 */
    if (source !== 'local' && u.must_change) {
      try { await env.DB.prepare('UPDATE users SET must_change = 0 WHERE username = ?').bind(u.username).run(); } catch (e) {}
      u.must_change = 0;
    }

    const token = newToken();
    const mins = normSessionMins(u.session_mins);
    const exp = new Date(Date.now() + mins * 60000).toISOString();
    await env.DB.prepare('INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(token, u.username, nowIso(), exp).run();
    await env.DB.prepare('UPDATE users SET last_login = ? WHERE username = ?').bind(nowIso(), u.username).run();
    try { await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()).run(); } catch (e) {}

    const payload = await bundleFor(env, u);
    payload.token = token;
    return ok(payload);
  }

  /* --- 附件读取（公开，按不可猜 id） --- */
  const ma = /^\/api\/attach\/([A-Za-z0-9]{8,40})$/.exec(p);
  if (ma && (method === 'GET' || method === 'HEAD')) {
    await ensureAttachTable(env);
    const row = await env.DB.prepare('SELECT id, name, mime, size, data FROM attachments WHERE id = ?').bind(ma[1]).first();
    if (!row) return bad('附件已删除', 404);
    const bytes = b64ToBytes(String(row.data || ''));
    const inline = INLINE_MIME.test(String(row.mime || ''));
    return new Response(method === 'HEAD' ? null : bytes, {
      status: 200,
      headers: {
        'content-type': row.mime || 'application/octet-stream',
        'content-length': String(bytes.length),
        'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', row.name),
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff'
      }
    });
  }

  /* --- 首页照片：读取（公开，no-cache + ETag；无图 404） --- */
  if (p === '/api/photo/current' && (method === 'GET' || method === 'HEAD')) {
    await ensurePhotoTable(env);
    const row = await env.DB.prepare('SELECT data, mime, size, updated_at FROM home_photo WHERE id = 1').first();
    if (!row || !row.data) return bad('未设置照片', 404);
    const bytes = b64ToBytes(String(row.data));
    const stamp = Math.floor((Date.parse(row.updated_at) || Date.now()) / 1000).toString(16);
    const etag = 'W/"photo-' + stamp + '-' + (row.size || bytes.length).toString(16) + '"';
    const headers = {
      'content-type': row.mime || 'image/jpeg',
      'cache-control': 'no-cache',
      'etag': etag,
      'x-content-type-options': 'nosniff'
    };
    const inm = request.headers.get('if-none-match');
    if (inm && inm.split(',').some(function (v) { return v.trim() === etag || v.trim() === '*'; })) {
      return new Response(null, { status: 304, headers: headers });
    }
    return new Response(method === 'HEAD' ? null : bytes, { status: 200, headers: headers });
  }

  /* --- 首页照片：上传（同源；文件头校验；1.4MB 上限受 D1 单行限制） --- */
  if (p === '/api/photo' && method === 'POST') {
    if (!sameOriginPhoto(request)) return bad('仅允许本站页面上传照片', 403);
    const m = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.data || ''));
    if (!m) return bad('不是有效的图片数据（需为 jpg / png / webp）');
    let bytes;
    try { bytes = b64ToBytes(m[1].replace(/\s+/g, '')); } catch (e) { return bad('不是有效的图片数据'); }
    if (bytes.length < 1024) return bad('图片数据过小，已忽略');
    if (bytes.length > PHOTO_MAX) {
      return bad('当前站点图片上限 ' + Math.round(PHOTO_MAX / 1024) + 'KB（D1 存储限制），请压缩后再上传');
    }
    const ext = sniffImage(bytes);
    if (!ext) return bad('文件内容不是有效的 jpg / png / webp 图片');
    await ensurePhotoTable(env);
    try {
      await env.DB.prepare(
        'INSERT INTO home_photo (id, data, mime, size, updated_at) VALUES (1, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET data = excluded.data, mime = excluded.mime, ' +
        'size = excluded.size, updated_at = excluded.updated_at'
      ).bind(bytesToB64(bytes), PHOTO_MIME[ext], bytes.length, nowIso()).run();
    } catch (e) {
      return bad('照片保存失败：' + (e && e.message ? e.message : '数据库写入错误'), 500);
    }
    return ok({ url: '/api/photo/current', size: bytes.length, ext: ext, at: Date.now() });
  }

  /* --- 首页照片：移除（同源；删后前端回落内置默认图） --- */
  if (p === '/api/photo' && method === 'DELETE') {
    if (!sameOriginPhoto(request)) return bad('仅允许本站页面操作', 403);
    await ensurePhotoTable(env);
    const r = await env.DB.prepare('DELETE FROM home_photo WHERE id = 1').run();
    return ok({ removed: (r.meta && r.meta.changes) ? true : false });
  }

  /* --- 以下均需登录 --- */
  const me = await currentUser(env, request);
  if (!me) return bad('登录已失效，请重新登录。', 401);
  const isAdmin = me.role === 'admin';

  if (p === '/api/auth/me' && method === 'GET') {
    return ok(await bundleFor(env, me));
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(me.token).run();
    return ok(null);
  }
  if (p === '/api/auth/password' && method === 'POST') {
    const oldPwd = String(body.oldPassword || '');
    const newPwd = String(body.newPassword || '');
    if (newPwd.length < 6) return bad('新密码至少 6 位');
    /* 远程账号的口令由 RADIUS / TACACS+ / LDAP 掌管，本系统改不了 */
    if ((me.source || 'local') !== 'local') {
      return bad('该账号使用「' + (AUTH_LABEL[me.source] || me.source) + '」认证，密码请到对应的认证系统修改。', 400);
    }
    const row = await env.DB.prepare('SELECT salt, hash FROM users WHERE username = ?').bind(me.username).first();
    if (!row) return bad('账号不存在', 404);
    if (await hashPwd(oldPwd, row.salt) !== row.hash) return bad('当前密码不正确');
    const salt = newSalt();
    await env.DB.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 0 WHERE username = ?')
      .bind(salt, await hashPwd(newPwd, salt), me.username).run();
    /* 保留当前会话，踢掉其它设备上的会话 */
    await env.DB.prepare('DELETE FROM sessions WHERE username = ? AND token <> ?').bind(me.username, me.token).run();
    return ok(null);
  }

  /* --- 巡检附件：上传 / 删除（需登录；读取见上） --- */
  if (p === '/api/attach' && method === 'POST') {
    /* 附件归属「人」而不是某一份台账：有多台账权限的账号至少有一份可写台账，允许上传 */
    if (!canWriteUser(me) && !(await hasMultiLedger(env, me))) return bad('当前账号为只读权限，不能上传附件。', 403);
    await ensureAttachTable(env);
    const name = safeFileName(body.name);
    const mime = String(body.mime || '').toLowerCase().split(';')[0].trim();
    const raw = String(body.data || '');
    const m = /^data:[^,]*,([A-Za-z0-9+/=\s]+)$/.exec(raw) || /^([A-Za-z0-9+/=\s]+)$/.exec(raw);
    if (!m) return bad('附件数据格式不正确');
    let bytes;
    try { bytes = b64ToBytes(m[1].replace(/\s+/g, '')); } catch (e) { return bad('附件数据格式不正确'); }
    if (!bytes.length) return bad('附件内容为空');
    if (bytes.length > ATTACH_MAX) {
      return bad('当前站点单文件上限 ' + Math.round(ATTACH_MAX / 1024) + 'KB（D1 存储限制），请压缩后重试');
    }
    const sniffed = sniffImage(bytes);
    let finalMime, ext;
    if (sniffed) {
      finalMime = sniffed === '.jpg' ? 'image/jpeg' : (sniffed === '.png' ? 'image/png' : 'image/webp');
      ext = sniffed;
    } else {
      ext = attachExtOf(name, mime);
      if (!ext) return bad('不支持的文件类型（支持图片、PDF、Office、文本、压缩包）');
      finalMime = ATTACH_MIME[ext].split(';')[0];
    }
    const id = randHex(12);
    try {
      await env.DB.prepare(
        'INSERT INTO attachments (id, name, mime, size, owner, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, name, finalMime, bytes.length, me.username, nowIso(), bytesToB64(bytes)).run();
    } catch (e) {
      return bad('附件保存失败：' + (e && e.message ? e.message : '数据库写入错误'), 500);
    }
    return ok({ id: id, name: name, mime: finalMime, size: bytes.length, url: '/api/attach/' + id });
  }

  const mAt = /^\/api\/attach\/([A-Za-z0-9]{8,40})$/.exec(p);
  if (mAt && method === 'DELETE') {
    if (!canWriteUser(me) && !(await hasMultiLedger(env, me))) return bad('当前账号为只读权限，不能删除附件。', 403);
    await ensureAttachTable(env);
    const row = await env.DB.prepare('SELECT id, owner FROM attachments WHERE id = ?').bind(mAt[1]).first();
    if (!row) return ok({ removed: false });
    if (!isAdmin && row.owner !== me.username) return bad('无权删除该附件', 403);
    await env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(row.id).run();
    return ok({ removed: true });
  }

  /* --- 台账读写：scope = 用户名；超管可读写任何人 --- */
  if (p === '/api/ledger' && method === 'GET') {
    return ok(await bundleFor(env, me));
  }
  if (p === '/api/ledger' && method === 'PUT') {
    /* mine=true 表示写「我的台账」：只属于本人，任何时候都可写（不受账号只读限制）；
       公共台账仍按账号权限判定，语义不变 */
    const wantMine = !!body.mine;
    if (!wantMine && !canWriteUser(me)) return bad('当前账号为只读权限，不能修改台账。', 403);
    const scope = normName(body.scope) || (wantMine ? me.username : '');
    if (!scope) return bad('缺少数据范围');
    if (!isAdmin && scope !== me.username) return bad('无权写入该账号的台账', 403);
    if (wantMine && !(await hasMultiLedger(env, me))) return bad('当前账号没有多台账权限', 403);
    if (isAdmin && !wantMine) {
      const exists = await env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(scope).first();
      if (!exists) return bad('目标账号不存在', 404);
    }
    const newData = sanitizeLedger(body.data);
    /* 敏感字段隐藏的账号：已存在客户的 contact/phone 回填库内原值，
       防止前端把 **** 占位（或清空值）写回破坏数据；新建客户占位值不落库 */
    if (me.hideSensitive) {
      const oldD = await readLedger(env, scope, wantMine);
      const om = {};
      ((oldD && oldD.customers) || []).forEach(function (c) { if (c && c.id) om[c.id] = c; });
      const stripMask = function (v) { return /^\*{2,}$/.test(String(v == null ? '' : v).trim()) ? '' : v; };
      newData.customers = (newData.customers || []).map(function (c) {
        if (!c) return c;
        if (c.id && om[c.id]) {
          return Object.assign({}, c, {
            contact: om[c.id].contact || '', phone: om[c.id].phone || ''
          });
        }
        return Object.assign({}, c, {
          contact: stripMask(c.contact), phone: stripMask(c.phone)
        });
      });
    }
    await writeLedger(env, scope, newData, me.username, wantMine);
    return ok({ scope: scope, mine: wantMine, updatedAt: nowIso() });
  }

  /* --- 认证服务器管理（仅超管） --- */
  if (p === '/api/auth-servers' && method === 'GET') {
    if (!isAdmin) return bad('仅超级管理员可查看认证服务器', 403);
    return ok({ servers: await listServers(env) });
  }

  if (p === '/api/auth-servers' && method === 'POST') {
    if (!isAdmin) return bad('仅超级管理员可新增认证服务器', 403);
    const v = ensureServerInput(body, null);
    if (v.err) return bad(v.err);
    const id = 'srv' + randHex(5);
    await env.DB.prepare(
      'INSERT INTO auth_servers (id, name, type, host, port, enabled, cfg, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, v.row.name, v.row.type, v.row.host, v.row.port, v.row.enabled, v.row.cfg, nowIso(), nowIso()).run();
    return ok({ server: serverView(await env.DB.prepare('SELECT * FROM auth_servers WHERE id = ?').bind(id).first(), 0) });
  }

  /* 测试连接：支持已保存的 id，也支持用弹窗里尚未保存的配置直接试 */
  if (p === '/api/auth-servers/test' && method === 'POST') {
    if (!isAdmin) return bad('仅超级管理员可测试认证服务器', 403);
    const sid = String(body.id || '').trim();
    const base = sid ? await env.DB.prepare('SELECT * FROM auth_servers WHERE id = ?').bind(sid).first() : null;
    if (sid && !base) return bad('认证服务器不存在', 404);
    const v = ensureServerInput(body, base);
    if (v.err) return bad(v.err);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return bad('请填写用于测试的账号与密码');
    const r = await remoteAuth({ type: v.row.type, host: v.row.host, port: v.row.port, cfg: v.row.cfg }, username, password);
    return ok({ ok: !!r.ok, code: r.code, message: r.message });
  }

  const msv = /^\/api\/auth-servers\/([A-Za-z0-9_-]{4,40})$/.exec(p);
  if (msv) {
    if (!isAdmin) return bad('仅超级管理员可修改认证服务器', 403);
    const srow = await env.DB.prepare('SELECT * FROM auth_servers WHERE id = ?').bind(msv[1]).first();
    if (!srow) return bad('认证服务器不存在', 404);

    if (method === 'PATCH') {
      const v = ensureServerInput(body, srow);
      if (v.err) return bad(v.err);
      await env.DB.prepare('UPDATE auth_servers SET name = ?, type = ?, host = ?, port = ?, enabled = ?, cfg = ?, updated_at = ? WHERE id = ?')
        .bind(v.row.name, v.row.type, v.row.host, v.row.port, v.row.enabled, v.row.cfg, nowIso(), srow.id).run();
      /* 类型变了要同步改绑该服务器的账号来源标记，否则登录会走错分支 */
      if (v.row.type !== srow.type) {
        await env.DB.prepare('UPDATE users SET source = ? WHERE server_id = ?').bind(v.row.type, srow.id).run();
      }
      return ok({ server: serverView(await env.DB.prepare('SELECT * FROM auth_servers WHERE id = ?').bind(srow.id).first(), 0) });
    }

    if (method === 'DELETE') {
      const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE server_id = ?').bind(srow.id).first();
      const n = cnt ? cnt.n : 0;
      if (n > 0) return bad('仍有 ' + n + ' 个账号使用该认证服务器，请先改绑或删除这些账号');
      await env.DB.prepare('DELETE FROM auth_servers WHERE id = ?').bind(srow.id).run();
      return ok(null);
    }
    return bad('不支持的请求方法', 405);
  }

  /* --- CRM 台账关联（询盘云/销售易，与内部部署版同一套逻辑） --- */
  if (p === '/api/crm/config' && method === 'GET') {
    if (!isAdmin) return bad('仅超级管理员可查看 CRM 配置', 403);
    const c = await readCrmConfig(env);
    return ok({
      configured: !!(c.loginName && c.password), loginName: c.loginName,
      intervalHours: c.intervalHours, lastSyncAt: c.lastSyncAt, lastResult: c.lastResult,
      running: false   /* Workers 无常驻进程，同步由 Cron 触发，不提供运行中标志 */
    });
  }
  if (p === '/api/crm/config' && method === 'PUT') {
    if (!isAdmin) return bad('仅超级管理员可修改 CRM 配置', 403);
    const c = await readCrmConfig(env);
    if (body.loginName !== undefined && !String(body.loginName || '').trim()) return bad('CRM 登录账号不能为空');
    if (body.password !== undefined && !String(body.password || '')) return bad('CRM 登录密码不能为空');
    c.loginName = body.loginName !== undefined ? String(body.loginName).trim() : c.loginName;
    c.password = body.password !== undefined ? String(body.password) : c.password;
    c.intervalHours = Math.max(1, Math.min(168, parseInt(body.intervalHours, 10) || c.intervalHours));
    if (body.resetSession) c.session = null;
    await saveCrmConfig(env, c);
    return ok({ configured: !!(c.loginName && c.password) });
  }
  if (p === '/api/crm/test' && method === 'POST') {
    if (!isAdmin) return bad('仅超级管理员可测试 CRM 连通性', 403);
    const c = await readCrmConfig(env);
    const loginName = body.loginName !== undefined ? String(body.loginName || '').trim() : c.loginName;
    const password = body.password !== undefined ? String(body.password || '') : c.password;
    if (!loginName || !password) return bad('请先填写 CRM 账号与密码');
    const lr = await CRM_P.xsyLogin({ loginName: loginName, password: password }, { fetchImpl: fetch });
    if (!lr.ok) return ok({ ok: false, stage: 'login', code: lr.code, message: lr.message });
    const fr = await CRM_P.fetchAllOpportunities(lr.session, { fetchImpl: fetch, maxPages: 1, pageSize: 200 });
    if (!fr.ok) return ok({ ok: false, stage: 'fetch', code: fr.code, message: fr.message });
    return ok({ ok: true, oppCount: fr.records.length, message: '连通正常：登录成功，拉取到 ' + fr.records.length + ' 条商机' });
  }
  if (p === '/api/crm/sync' && method === 'POST') {
    if (!isAdmin) return bad('仅超级管理员可触发 CRM 检索', 403);
    if (!(await crmConfigured(env))) return bad('请先保存 CRM 账号配置');
    /* 公网这一版请求是同步等待整轮跑完的，重复点击会并发跑两轮，这里拦住 */
    if (crmProgressMem && crmProgressMem.running) {
      return ok({ started: false, message: '上一轮检索仍在进行中', progress: crmProgressMem });
    }
    const r = await doCrmSync(env, 'manual');
    return ok(r && r.ok ? { started: true, result: r, progress: crmProgressMem } : { started: false, result: r, progress: crmProgressMem });
  }
  if (p === '/api/crm/status' && method === 'GET') {
    if (!isAdmin) return bad('仅超级管理员可查看 CRM 匹配状态', 403);
    const c = await readCrmConfig(env);
    const map = {};
    const r = await env.DB.prepare('SELECT * FROM crm_matches').all();
    (r.results || []).forEach(function (row) { map[row.customer_name] = row; });
    const names = await collectCustomerNames(env);
    const progress = crmProgressMem || await readCrmProgress(env);
    return ok({
      lastSyncAt: c.lastSyncAt, lastResult: c.lastResult,
      running: !!(progress && progress.running),
      progress: progress,
      items: names.sort().map(function (n) {
        const row = map[n];
        let data = {};
        try { data = JSON.parse((row && row.data) || '{}') || {}; } catch (e) {}
        return {
          name: n, status: row ? row.status : 'pending', level: row ? row.level : 0,
          multi: row ? !!row.multi : false, updatedAt: row ? row.updated_at : '',
          hitCount: (data.projects || []).length || (data.maintenance && data.maintenance.length ? 1 : 0),
          projects: (data.projects || []).map(function (pj) { return pj.name || ''; }),
          error: data.error || null, warranty: data.warranty || null
        };
      })
    });
  }
  /* --- 区域统计（按战区；公网分批续跑） ---
     读：超管 + stat_visible 账号；触发检索：仅超管 */
  if (p === '/api/crm/stat/meta' && method === 'GET') {
    if (!isAdmin && !me.statVisible) return bad('没有区域统计的查看权限', 403);
    const regions = await readStatRegions(env);
    let cached = [];
    try {
      const r = await env.DB.prepare('SELECT region, updated_at, data FROM crm_stat').all();
      cached = (r.results || []).map(function (row) {
        let d = {};
        try { d = JSON.parse(row.data || '{}') || {}; } catch (e) {}
        return { region: row.region, updatedAt: row.updated_at, stats: d.stats || null };
      });
    } catch (e) {}
    const prog = crmStatMem || await readStatProgress(env);
    return ok({
      regions: regions, cached: cached,
      running: !!(prog && prog.running), region: (prog && prog.region) || '', progress: prog
    });
  }
  if (p === '/api/crm/stat/data' && method === 'GET') {
    if (!isAdmin && !me.statVisible) return bad('没有区域统计的查看权限', 403);
    const region = String(url.searchParams.get('region') || '').trim();
    if (!region) return bad('缺少区域名称');
    let row = null;
    try {
      row = await env.DB.prepare('SELECT * FROM crm_stat WHERE region = ?').bind(region).first();
    } catch (e) {}
    if (!row) return ok({ found: false, region: region });
    let d = {};
    try { d = JSON.parse(row.data || '{}') || {}; } catch (e) {}
    let rows = d.rows || [];
    if (!rows.length) {
      /* 明细在分片表里（大战区），主行只有统计与汇总 */
      try {
        const cr = await env.DB.prepare('SELECT data FROM crm_stat_chunk WHERE region = ? ORDER BY idx').bind(region).all();
        (cr.results || []).forEach(function (c) {
          try {
            const arr = JSON.parse(c.data || '[]');
            if (Array.isArray(arr)) rows = rows.concat(arr);
          } catch (e) {}
        });
      } catch (e) {}
    }
    return ok({
      found: true, region: region, updatedAt: row.updated_at,
      stats: d.stats || null, rows: rows, summary: d.summary || [],
      projects: d.projects || [], truncated: !!d.truncated
    });
  }
  if (p === '/api/crm/stat/run' && method === 'POST') {
    if (!isAdmin) return bad('仅超级管理员可触发区域统计检索', 403);
    if (!(await crmConfigured(env))) return bad('请先保存 CRM 账号配置');
    const region = String(body.region || '').trim();
    if (!region) return bad('请选择区域名称');
    /* 同步跑一批（约 10-15 秒）：前端轮询到 needNext 后再发下一批 */
    const r = await doRegionStatBatch(env, region, !!body.reset);
    if (r.ok === false) return ok({ started: false, message: r.message, progress: r.progress });
    return ok({ started: true, partial: !!r.partial, progress: r.progress });
  }
  if (p === '/api/crm/stat/status' && method === 'GET') {
    if (!isAdmin && !me.statVisible) return bad('没有区域统计的查看权限', 403);
    const prog = crmStatMem || await readStatProgress(env);
    return ok({ running: !!(prog && prog.running), region: (prog && prog.region) || '', progress: prog });
  }

  if (p === '/api/crm/data' && method === 'GET') {
    /* me 已由 mapUser 转成驼峰字段：这里必须读 crmVisible / nameCn。
       crm_visible 只管「非我负责的现网信息」；「我负责的项目」（维护人A = 本人中文名）
       对全员开放，关闭开关也要回（2026-11-06 调整） */
    const mineOnly = !me.crmVisible && me.role !== 'admin';
    /* 多台账：客户端可指定按哪一份台账的客户清单过滤（?mine=1 为「我的台账」），
       默认公共台账，与旧行为一致 */
    const wantMine = url.searchParams.get('mine') === '1';
    let allow = null;
    if (me.role !== 'admin') {
      allow = {};
      const d = await readLedger(env, me.username, wantMine && (await hasMultiLedger(env, me)));
      (d && Array.isArray(d.customers) ? d.customers : []).forEach(function (c) { if (c && c.name) allow[c.name] = true; });
    }
    const myName = String(me.nameCn || '').trim();
    const matches = {};
    const r = await env.DB.prepare('SELECT * FROM crm_matches').all();
    (r.results || []).forEach(function (row) {
      if (allow && !allow[row.customer_name]) return;
      let data = {};
      try { data = JSON.parse(row.data || '{}') || {}; } catch (e) {}
      if (mineOnly) {
        const owner = String((data.opp && data.opp['维护人A']) || '').trim();
        if (!myName || row.status !== 'ok' || owner !== myName) return;
      }
      matches[row.customer_name] = {
        status: row.status, recordId: row.record_id, level: row.level, multi: !!row.multi,
        opp: data.opp || null, maintenance: data.maintenance || [],
        projects: data.projects || [], hitCount: (data.projects || []).length || 1,
        warranty: data.warranty || null, updatedAt: row.updated_at
      };
    });
    return ok({ crmVisible: !mineOnly, mineOnly: mineOnly, matches: matches, nameCn: myName });
  }

  /* --- 用户管理（仅超管） --- */
  if (p === '/api/users' && method === 'GET') {
    if (!isAdmin) return bad('仅超级管理员可查看用户列表', 403);
    const smap = await serversMap(env);
    const r = await env.DB.prepare(
      'SELECT ' + USER_COLS + ' FROM users ORDER BY created_at'
    ).all();
    return ok({ users: (r.results || []).map(function (row) { return mapUser(row, smap); }) });
  }

  if (p === '/api/users' && method === 'POST') {
    if (!isAdmin) return bad('仅超级管理员可创建用户', 403);
    const username = normName(body.username);
    const name = String(body.name || '').trim();
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!validUsername(username)) return bad('用户名需为 3–32 位字母、数字、下划线、点或连字符');
    if (!name) return bad('请填写显示名称');
    const dup = await env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(username).first();
    if (dup) return bad('用户名「' + username + '」已存在');
    /* 权限：只读 ro 不能改台账；超管恒为读写 */
    const perm = role === 'admin' ? 'rw' : (body.perm === 'ro' ? 'ro' : 'rw');
    /* 账号来源：指定认证服务器即为远程账号，类型取服务器自身的 type（不信任前端传值） */
    const serverId = String(body.serverId || '').trim();
    let source = 'local';
    if (serverId) {
      const srv = await env.DB.prepare('SELECT * FROM auth_servers WHERE id = ?').bind(serverId).first();
      if (!srv) return bad('所选认证服务器不存在');
      if (!srv.enabled) return bad('所选认证服务器已停用');
      source = srv.type;
    }

    /* 数据集：shareFrom = 与该用户共用同一份台账（双向同步），不复制数据 */
    let shareFrom = '';
    if (body.shareFrom) {
      const src = normName(body.shareFrom);
      const srcRow = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(src).first();
      if (!srcRow) return bad('要共享数据的来源用户不存在');
      shareFrom = srcRow.share_from || src;
      if (role === 'admin' && shareFrom !== username) {
        return bad('超级管理员维护全局数据，不参与共享数据集');
      }
    }

    /* 迁移路径：带 salt+hash 表示沿用原口令（本地旧版迁入），不需要重新设密码 */
    const legacySalt = String(body.salt || '');
    const legacyHash = String(body.hash || '');
    const isLegacy = /^[A-Za-z0-9]{4,64}$/.test(legacySalt) && /^[0-9a-f]{64}$/.test(legacyHash);

    let salt = '', hash = '', mustChange = 0;
    if (source === 'local') {
      if (isLegacy) {
        salt = legacySalt; hash = legacyHash; mustChange = 0;
      } else {
        const pwd = String(body.password || '');
        if (pwd.length < 6) return bad('密码至少 6 位');
        salt = newSalt();
        hash = await hashPwd(pwd, salt);
        mustChange = 1;
      }
    } else if (body.password) {
      return bad('远程账号的密码由「' + AUTH_LABEL[source] + '」服务器校验，请不要在本地设置密码');
    }
    /* 多台账：处在共享关系里的账号才有第二份台账（借入 = 设了共享来源；借出 = 有下家指向它）。
       超管维护全局数据，不参与共享数据集，永远没有第二份台账。 */
    const hasDown = (role !== 'admin' && !shareFrom) ? await hasSharedTo(env, username) : false;
    const multiLedger = (role !== 'admin' && body.multiLedger && (shareFrom || hasDown)) ? 1 : 0;
    await env.DB.prepare(
      'INSERT INTO users (username, name, role, status, note, salt, hash, must_change, created_at, source, perm, server_id, share_from, session_mins, hide_sensitive, name_cn, crm_visible, stat_visible, multi_ledger) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(username, name, role, 'active', String(body.note || ''), salt, hash, mustChange, nowIso(), source, perm, serverId, shareFrom, normSessionMins(body.sessionMins), body.hideSensitive ? 1 : 0, String(body.nameCn || '').trim(), body.crmVisible ? 1 : 0, body.statVisible ? 1 : 0, multiLedger).run();
    /* 共享成员不写数据（用的是 owner 的台账）；普通初始化才落 body.data */
    if (!shareFrom && body.data) await writeLedger(env, username, sanitizeLedger(body.data), me.username);
    return ok({ user: mapUser(await env.DB.prepare(
      'SELECT ' + USER_COLS + ' FROM users WHERE username = ?'
    ).bind(username).first(), await serversMap(env)) });
  }

  const mu = /^\/api\/users\/([^/]+)$/.exec(p);
  if (mu) {
    const target = normName(decodeURIComponent(mu[1]));
    if (!isAdmin) return bad('仅超级管理员可修改用户', 403);
    const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(target).first();
    if (!row) return bad('用户不存在', 404);

    if (method === 'PATCH') {
      const name = body.name == null ? row.name : String(body.name).trim();
      const role = body.role == null ? row.role : (body.role === 'admin' ? 'admin' : 'user');
      const status = body.status == null ? row.status : (body.status === 'disabled' ? 'disabled' : 'active');
      const note = body.note == null ? (row.note || '') : String(body.note);
      const perm = role === 'admin' ? 'rw' : (body.perm == null ? (row.perm || 'rw') : (body.perm === 'ro' ? 'ro' : 'rw'));
      const losingAdmin = row.role === 'admin' && row.status === 'active' && (role !== 'admin' || status !== 'active');
      if (losingAdmin && await activeAdminCount(env, target) === 0) {
        return bad('至少需要保留一个启用的超级管理员');
      }

      /* 来源变更：body.serverId 传空串表示改回本地账号 */
      let source = row.source || 'local';
      let serverId = row.server_id || '';
      let sourceChanged = false;
      if (body.serverId !== undefined) {
        const sid = String(body.serverId || '').trim();
        if (sid) {
          const srv = await env.DB.prepare('SELECT * FROM auth_servers WHERE id = ?').bind(sid).first();
          if (!srv) return bad('所选认证服务器不存在');
          if (!srv.enabled) return bad('所选认证服务器已停用');
          source = srv.type;
        } else {
          source = 'local';
        }
        serverId = sid;
        sourceChanged = (source !== (row.source || 'local')) || (serverId !== (row.server_id || ''));
      }
      /* 从远程改回本地时必须给一个本地口令，否则这个账号将无法登录 */
      const wantsLocalWithoutPwd = source === 'local' && !row.hash && !(body.password && String(body.password).length);
      if (wantsLocalWithoutPwd) return bad('改为本地账号时需要设置初始密码（至少 6 位）');
      if (source !== 'local' && body.password) {
        return bad('远程账号的密码由「' + AUTH_LABEL[source] + '」服务器校验，不能在本地重置');
      }

      /* 多台账：既没有共享来源、也没有下家指向它，或降级为超管时自动关掉
         （数据保留，重新开启可继续用） */
      const stillShared = !!(row.share_from || '').length || await hasSharedTo(env, target);
      const multiNow = stillShared && role !== 'admin'
        ? (body.multiLedger == null ? (row.multi_ledger ? 1 : 0) : (body.multiLedger ? 1 : 0))
        : 0;
      await env.DB.prepare('UPDATE users SET name = ?, role = ?, status = ?, note = ?, perm = ?, source = ?, server_id = ?, session_mins = ?, hide_sensitive = ?, name_cn = ?, crm_visible = ?, stat_visible = ?, multi_ledger = ? WHERE username = ?')
        .bind(name, role, status, note, perm, source, serverId, normSessionMins(body.sessionMins == null ? row.session_mins : body.sessionMins), body.hideSensitive == null ? (row.hide_sensitive ? 1 : 0) : (body.hideSensitive ? 1 : 0), body.nameCn == null ? (row.name_cn || '') : String(body.nameCn).trim(), body.crmVisible == null ? (row.crm_visible ? 1 : 0) : (body.crmVisible ? 1 : 0), body.statVisible == null ? (row.stat_visible ? 1 : 0) : (body.statVisible ? 1 : 0), multiNow, target).run();
      if (body.password != null && String(body.password).length) {
        const np = String(body.password);
        if (np.length < 6) return bad('密码至少 6 位');
        const salt = newSalt();
        await env.DB.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 1 WHERE username = ?')
          .bind(salt, await hashPwd(np, salt), target).run();
        await env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(target).run();
      } else if (sourceChanged) {
        /* 换了认证来源后旧会话的权限语义已变，强制其重新登录 */
        await env.DB.prepare('DELETE FROM sessions WHERE username = ? AND username <> ?').bind(target, me.username).run();
        if (source !== 'local') {
          /* 改为远程认证后本系统无法改密，遗留的强制改密标记一并清掉 */
          await env.DB.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 0 WHERE username = ?').bind('', '', target).run();
        }
      }
      return ok({ user: mapUser(await env.DB.prepare(
        'SELECT ' + USER_COLS + ' FROM users WHERE username = ?'
      ).bind(target).first(), await serversMap(env)) });
    }

    if (method === 'DELETE') {
      if (target === me.username) return bad('不能删除当前登录账号');
      if (row.role === 'admin' && row.status === 'active' && await activeAdminCount(env, target) === 0) {
        return bad('至少保留一个启用的超级管理员，无法删除');
      }
      /* 共享数据集：删 owner 且有成员 → 台账转给最早成员；删成员 → 数据不动 */
      const stmts = [env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(target)];
      if (!(row.share_from || '').length) {
        const members = await shareMembers(env, target);
        if (members.length) {
          const heir = members[0];
          stmts.push(env.DB.prepare('UPDATE ledgers SET username = ? WHERE username = ?').bind(heir, target));
          stmts.push(env.DB.prepare('UPDATE ledger_logs SET username = ? WHERE username = ?').bind(heir, target));
          stmts.push(env.DB.prepare('UPDATE users SET share_from = ? WHERE share_from = ?').bind(heir, target));
          /* 归属者本人不再指向别人 */
          stmts.push(env.DB.prepare("UPDATE users SET share_from = '' WHERE username = ?").bind(heir));
        } else {
          stmts.push(env.DB.prepare('DELETE FROM ledgers WHERE username = ?').bind(target));
        }
      }
      stmts.push(env.DB.prepare('DELETE FROM users WHERE username = ?').bind(target));
      /* 个人台账（<用户名>::mine）随账号一起清理，避免留下无主数据 */
      stmts.push(env.DB.prepare('DELETE FROM ledgers WHERE username = ?').bind(mineKey(target)));
      stmts.push(env.DB.prepare('DELETE FROM ledger_logs WHERE username = ?').bind(mineKey(target)));
      await env.DB.batch(stmts);
      /* 附件表可能尚未创建（从未上传过附件），失败不影响删号 */
      try { await env.DB.prepare('DELETE FROM attachments WHERE owner = ?').bind(target).run(); } catch (e) {}
      return ok(null);
    }
    return bad('不支持的请求方法', 405);
  }

  /* --- 数据变更日志：按数据归属（共享数据集共用一份历史）查询 --- */
  if (p === '/api/logs' && method === 'GET') {
    const req = normName(url.searchParams.get('username') || me.username);
    if (!await env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(req).first()) {
      return bad('用户不存在', 404);
    }
    if (!isAdmin && req !== me.username) return bad('无权查看该账号的数据日志', 403);
    const wantMine = url.searchParams.get('mine') === '1';
    if (wantMine && !isAdmin && !(await hasMultiLedger(env, me))) return bad('当前账号没有多台账权限', 403);
    const owner = await ledgerKeyOf(env, req, wantMine);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500);
    const r = await env.DB.prepare(
      'SELECT actor, kind, action, target, detail, at FROM ledger_logs WHERE username = ? ORDER BY id DESC LIMIT ?'
    ).bind(owner, limit).all();
    return ok({ owner: owner, logs: r.results || [] });
  }

  /* --- 高德地图 WebService 代理（地点搜索 / 地理编码），与内网版契约一致 --- */
  if (p === '/api/place/search' && method === 'GET') {
    const akey = env.AMAP_KEY || DEFAULT_AMAP_KEY;
    const type = url.searchParams.get('type') === 'geocode' ? 'geocode' : 'suggestion';
    const amapParams = new URLSearchParams({ key: akey });
    let kwText = '';
    if (type === 'geocode') {
      kwText = String(url.searchParams.get('address') || '').trim().slice(0, 120);
      if (!kwText) return bad('请输入地址');
      amapParams.set('address', kwText);
    } else {
      kwText = String(url.searchParams.get('keyword') || '').trim().slice(0, 100);
      if (!kwText) return bad('请输入关键词');
      amapParams.set('keywords', kwText);
      const region = String(url.searchParams.get('region') || '').trim().slice(0, 40);
      if (region) { amapParams.set('city', region); amapParams.set('citylimit', 'false'); }
    }
    const amapPath = type === 'geocode' ? '/v3/geocode/geo' : '/v3/assistant/inputtips';
    try {
      const r = await fetch('https://restapi.amap.com' + amapPath + '?' + amapParams.toString(),
        { signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
      const j = await r.json();
      if (String(j.status) !== '1') {
        return ok({ status: 1, message: amapErrMsg(j.infocode, j.info) });
      }
      if (type === 'geocode') {
        const g = (j.geocodes || [])[0];
        if (!g || !g.location) return ok({ status: 1, message: '未找到匹配地址' });
        const ll = String(g.location || '').split(',');
        return ok({
          status: 0,
          result: {
            title: g.formatted_address || kwText,
            address: g.formatted_address || '',
            location: { lng: Number(ll[0]), lat: Number(ll[1]) }
          }
        });
      }
      const list = (j.tips || [])
        .filter(function (t) { return t && t.location && typeof t.location === 'string' && t.location.indexOf(',') >= 0; })
        .map(function (t) {
          const ll = t.location.split(',');
          return {
            title: t.name || '未命名地点',
            address: t.address && typeof t.address === 'string' ? t.address : (t.district || ''),
            location: { lng: Number(ll[0]), lat: Number(ll[1]) }
          };
        });
      return ok({ status: 0, data: list });
    } catch (e) {
      return bad('检索服务连接失败，请稍后重试', 502);
    }
  }

  return bad('接口不存在', 404);
}

/* ---------------- 静态资源安全头 ---------------- */

/* 本次部署的版本号（wrangler.jsonc 的 version_metadata 绑定）。
   本地 wrangler dev 或未注入时返回空串，此时不生成 ETag，退化为原有行为。 */
function deployTag(env) {
  try {
    const m = env && env.CF_VERSION_METADATA;
    return (m && m.id) ? String(m.id) : '';
  } catch (e) { return ''; }
}

/* If-None-Match 可能带多个值、可能带 W/ 前缀，逐个比对 */
function etagMatches(header, etag) {
  if (!header) return false;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some(function (raw) {
    const v = raw.trim();
    return v === etag || v === bare || v === '*' ;
  });
}

function securityWrapped(res, request, url, env) {
  const h = new Headers(res.headers);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('permissions-policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
  const ct = h.get('content-type') || '';

  if (ct.indexOf('text/html') >= 0) {
    /* 网页缓存策略：允许浏览器直接复用短时间内的副本。
       背景：Workers 静态资源不返回 ETag/Last-Modified，若下发 no-cache，
       浏览器每次打开都必须回源取完整页面（看板 565 KB / br 后 216 KB），
       在跨洋链路上表现为几十秒等待；且实测 Cloudflare 边缘层会剥离 Worker
       设置的 ETag，靠 304 省流量的路子走不通。
       改为 max-age 短缓存 + stale-while-revalidate：3 分钟内重复打开零请求，
       过期后先用旧副本渲染再后台更新。代价是改版后最多延迟 3 分钟可见，
       数据本身走 /api（no-store），不受影响。 */
    h.set('cache-control', 'public, max-age=180, stale-while-revalidate=600');
    const tag = deployTag(env);
    /* 可观测：从响应头可确认部署版本 */
    h.set('x-deploy-ver', tag || 'none');
    if (tag) {
      const etag = 'W/"' + tag + '"';
      h.set('etag', etag);
      if (etagMatches(request.headers.get('if-none-match'), etag)) {
        h.delete('content-length');
        h.delete('content-encoding');
        return new Response(null, { status: 304, statusText: 'Not Modified', headers: h });
      }
    }
  } else if (url.pathname.indexOf('/assets/') === 0) {
    h.set('cache-control', 'public, max-age=31536000, immutable');
  }

  const body = request.method === 'HEAD' ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.indexOf('/api/') === 0) {
      try {
        return await route(request, env);
      } catch (e) {
        return bad('服务器内部错误：' + (e && e.message ? e.message : '未知'), 500);
      }
    }
    const res = await env.ASSETS.fetch(request);
    return securityWrapped(res, request, url, env);
  },
  /* Cron Trigger：CRM 台账关联定时检索（配置齐全才跑；间隔在配置里判断）。
     wrangler.toml 的 [triggers] crons 至少配一个每小时触发（如 "0 * * * *"）。 */
  async scheduled(event, env) {
    try {
      await ensureSchema(env);
      const cfg = await readCrmConfig(env);
      if (!(cfg.loginName && cfg.password)) return;
      const due = cfg.lastSyncAt ? Date.parse(cfg.lastSyncAt) + cfg.intervalHours * 3600 * 1000 : 0;
      if (Date.now() >= due) await doCrmSync(env, 'scheduled');
    } catch (e) { /* 定时任务失败不影响请求面 */ }
  }
};
