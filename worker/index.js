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
function mapUser(row, srvMap) {
  const source = row.source || 'local';
  const sid = row.server_id || '';
  const srv = (sid && srvMap) ? srvMap[sid] : null;
  return {
    id: row.username,
    username: row.username,
    name: row.name,
    role: row.role,
    status: row.status,
    note: row.note || '',
    mustChange: !!row.must_change,
    createdAt: (row.created_at || '').slice(0, 10),
    lastLogin: row.last_login || '',
    source: source,
    perm: row.perm === 'ro' ? 'ro' : 'rw',
    serverId: sid,
    serverName: srv ? srv.name : (sid ? '（认证服务器已删除）' : ''),
    serverType: srv ? srv.type : (sid ? '' : source),
    shareFrom: row.share_from || '',
    sessionMins: normSessionMins(row.session_mins)
  };
}
function normName(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function validUsername(u) { return /^[A-Za-z0-9_.-]{3,32}$/.test(u); }
const USER_COLS = 'username, name, role, status, note, must_change, created_at, last_login, source, perm, server_id, share_from, session_mins';

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
    'ALTER TABLE users ADD COLUMN session_mins INTEGER NOT NULL DEFAULT 30'
  ];
  for (const sql of cols) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 列已存在 */ }
  }
  try {
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
    'u.source, u.perm, u.server_id, u.session_mins ' +
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

/* ---------------- 数据读写（共享数据集：share_from 指向数据归属者，一层） ---------------- */
async function dataOwner(env, username) {
  const row = await env.DB.prepare('SELECT share_from FROM users WHERE username = ?').bind(username).first();
  return (row && row.share_from) ? row.share_from : username;
}
async function shareMembers(env, owner) {
  const r = await env.DB.prepare('SELECT username FROM users WHERE share_from = ? ORDER BY created_at').bind(owner).all();
  return (r.results || []).map(function (x) { return x.username; });
}
async function readLedger(env, username) {
  const owner = await dataOwner(env, username);
  const row = await env.DB.prepare('SELECT data FROM ledgers WHERE username = ?').bind(owner).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (e) { return null; }
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
async function writeLedger(env, username, data, by) {
  const owner = await dataOwner(env, username);
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
  const ledgers = {};
  if (isAdmin) {
    for (const row of users) {
      const d = await readLedger(env, row.username);   /* 共享成员解析到 owner 的数据 */
      if (d) ledgers[row.username] = d;
    }
  } else {
    const d = await readLedger(env, u.username);
    if (d) ledgers[u.username] = d;
  }
  for (const x of users) {
    x.sharedWith = await shareMembers(env, x.username);
  }
  return {
    user: mapUser(u, srvMap), users: users, ledgers: ledgers, admin: isAdmin,
    canWrite: canWriteUser(u), attachMax: ATTACH_MAX,
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
    if (!canWriteUser(me)) return bad('当前账号为只读权限，不能上传附件。', 403);
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
    if (!canWriteUser(me)) return bad('当前账号为只读权限，不能删除附件。', 403);
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
    if (!canWriteUser(me)) return bad('当前账号为只读权限，不能修改台账。', 403);
    const scope = normName(body.scope);
    if (!scope) return bad('缺少数据范围');
    if (!isAdmin && scope !== me.username) return bad('无权写入该账号的台账', 403);
    if (isAdmin) {
      const exists = await env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(scope).first();
      if (!exists) return bad('目标账号不存在', 404);
    }
    await writeLedger(env, scope, sanitizeLedger(body.data), me.username);
    return ok({ scope: scope, updatedAt: nowIso() });
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
    await env.DB.prepare(
      'INSERT INTO users (username, name, role, status, note, salt, hash, must_change, created_at, source, perm, server_id, share_from, session_mins) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(username, name, role, 'active', String(body.note || ''), salt, hash, mustChange, nowIso(), source, perm, serverId, shareFrom, normSessionMins(body.sessionMins)).run();
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

      await env.DB.prepare('UPDATE users SET name = ?, role = ?, status = ?, note = ?, perm = ?, source = ?, server_id = ?, session_mins = ? WHERE username = ?')
        .bind(name, role, status, note, perm, source, serverId, normSessionMins(body.sessionMins == null ? row.session_mins : body.sessionMins), target).run();
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
          await env.DB.prepare('UPDATE users SET salt = ?, hash = ? WHERE username = ?').bind('', '', target).run();
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
    const owner = await dataOwner(env, req);
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
  }
};
