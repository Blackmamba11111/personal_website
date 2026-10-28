/* ============================================================================
 * 客户巡检台账 · 内部部署服务端（单进程：静态资源 + /api）
 *
 * 由 Cloudflare Workers 版本等价移植，接口契约、口令算法、权限模型完全一致：
 *   · 鉴权   Bearer Token，sessions 表，30 天
 *   · 口令   随机盐 + 400 轮 SHA-256（与前端 hashPwd 同算法）
 *   · 存储   SQLite（Node 24 内置 node:sqlite，WAL），单文件 /data/inspection.db
 *
 * 设计取舍：不引入任何 npm 依赖。内网出口对 Cloudflare 网段（npmjs.org /
 * nodejs.org）不可达，原生模块编译会失败；内置 SQLite 让构建过程完全离线，
 * 只需一个 node 基础镜像即可交付。
 *
 * 启动环境变量：
 *   PORT               监听端口，默认 8443
 *   APP_DIR            静态资源根目录，默认 /app
 *   DATA_DIR           数据目录（挂载卷），默认 /data
 *   TLS_CERT/TLS_KEY   PEM 证书与私钥路径；两者都存在时启用 HTTPS，否则退回 HTTP
 *   HTTPS_PORT         对外 HTTPS 端口（仅用于拼跳转地址），默认 443
 *   HTTP_REDIRECT_PORT 额外监听一个明文端口并 301 跳到 HTTPS；0 表示不启用
 *   TMAP_KEY           腾讯地图 WebService Key（地点检索代理），默认内置 Key
 * ==========================================================================*/

'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '8443', 10);
const APP_DIR = path.resolve(process.env.APP_DIR || '/app');
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const SESSION_DAYS = 30;
const HASH_ROUNDS = 400;
const MAX_BODY = 32 * 1024 * 1024; // 台账 JSON 可能较大
/* 腾讯地图 WebService Key（地点检索代理用）：页面已公开该 Key，此处仅作服务端默认值；
   可用环境变量 TMAP_KEY 覆盖。浏览器直连 apis.map.qq.com 会被 CORS 拦截，必须走本代理。 */
const DEFAULT_TMAP_KEY = '5BDBZ-G6VEQ-SAM5O-BQSZP-FCV6T-DHFMA';
/* 高德地图 Key（2026-10 换用）：Web 服务 + JS API 同一 Key，可用环境变量 AMAP_KEY 覆盖 */
const DEFAULT_AMAP_KEY = '96eb5c271c76440bcb9a15ed493fa350';
/* 高德 WS 常见 infocode → 可读提示 */
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
/* TLS：进程内终止（https.createServer），无需前置 nginx。
   证书缺失时退回 HTTP 明文（便于本地调试），生产环境务必提供证书。 */
const TLS_CERT = process.env.TLS_CERT || '/certs/server.crt';
const TLS_KEY = process.env.TLS_KEY || '/certs/server.key';
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443', 10);
const REDIRECT_PORT = parseInt(process.env.HTTP_REDIRECT_PORT || '0', 10);

/* ---------------- 数据库 ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
/* 首页照片存放目录：必须落在 DATA_DIR（挂载卷）内。
   静态文件在构建时 COPY 进镜像，写 /app/assets 会在下次 rebuild 后丢失。 */
const PHOTO_DIR = path.join(DATA_DIR, 'photo');
fs.mkdirSync(PHOTO_DIR, { recursive: true });
/* 巡检附件（图片/文件）：同样必须落在挂载卷内 */
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'inspection.db');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user',
  status      TEXT NOT NULL DEFAULT 'active',
  note        TEXT NOT NULL DEFAULT '',
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  last_login  TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'local',
  perm        TEXT NOT NULL DEFAULT 'rw',
  server_id   TEXT NOT NULL DEFAULT '',
  share_from  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS auth_servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  host       TEXT NOT NULL,
  port       INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  cfg        TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ledgers (
  username   TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  owner      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  ext        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner);
CREATE TABLE IF NOT EXISTS ledger_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,             /* 数据归属（共享数据集的 owner 用户名） */
  actor      TEXT NOT NULL,             /* 实际操作人 */
  kind       TEXT NOT NULL,             /* customer / visit / region / init */
  action     TEXT NOT NULL,             /* add / update / delete */
  target     TEXT NOT NULL DEFAULT '',  /* 对象名称（客户名 / 日期 / 区域名） */
  detail     TEXT NOT NULL DEFAULT '',  /* 字段级变更明细 */
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_logs_owner ON ledger_logs(username, at);
`);

/* 老库补列：attachments.ext（存盘真实扩展名）。SQLite 无 ADD COLUMN IF NOT EXISTS，先查 pragma */
try {
  const cols = db.prepare('PRAGMA table_info(attachments)').all().map(function (c) { return c.name; });
  if (cols.length && cols.indexOf('ext') < 0) {
    db.exec("ALTER TABLE attachments ADD COLUMN ext TEXT NOT NULL DEFAULT ''");
    console.log('[migrate] attachments 增加 ext 列');
  }
} catch (e) {
  console.error('[migrate] attachments.ext 处理失败：' + (e && e.message));
}

/* 老库补列：users.source / perm / server_id（本地用户 → 本地/远程用户、读写/只读权限） */
try {
  const ucols = db.prepare('PRAGMA table_info(users)').all().map(function (c) { return c.name; });
  const add = [
    ['source', "ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'local'"],
    ['perm', "ALTER TABLE users ADD COLUMN perm TEXT NOT NULL DEFAULT 'rw'"],
    ['server_id', "ALTER TABLE users ADD COLUMN server_id TEXT NOT NULL DEFAULT ''"],
    ['share_from', "ALTER TABLE users ADD COLUMN share_from TEXT NOT NULL DEFAULT ''"]
  ];
  add.forEach(function (pair) {
    if (ucols.indexOf(pair[0]) < 0) {
      db.exec(pair[1]);
      console.log('[migrate] users 增加 ' + pair[0] + ' 列');
    }
  });
} catch (e) {
  console.error('[migrate] users 账号来源列处理失败：' + (e && e.message));
}

/* ---------------- 基础工具 ---------------- */
function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function hashPwd(pwd, salt) {
  let x = String(salt) + '|' + String(pwd);
  for (let i = 0; i < HASH_ROUNDS; i++) x = sha256Hex(x + '#' + i + '|' + salt);
  return x;
}
function randHex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }
function newSalt() { return 'S' + randHex(8); }
function newToken() { return randHex(24); }
function nowIso() { return new Date().toISOString(); }
function normName(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function validUsername(u) { return /^[A-Za-z0-9_.-]{3,32}$/.test(u); }

/* 认证来源：local = 本地口令；radius / tacacs / ldap = 由对应认证服务器校验
   perm：rw = 读写；ro = 只读（可看可导出，不能改台账）
   mapUser 的第二个参数是「认证服务器 id → 记录」的映射，用于带出名称，避免前端二次查询 */
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
    shareFrom: row.share_from || ''
  };
}

/* ---------------- 认证服务器（远程用户） ---------------- */
/* cfg 里可能含共享密钥，绝不能原样回传前端：列表接口只给 hasSecret 标记 */
const AUTH_TYPES = ['radius', 'tacacs', 'ldap'];
const AUTH_DEFAULT_PORT = { radius: 1812, tacacs: 49, ldap: 389 };
const AUTH_LABEL = { local: '本地', radius: 'RADIUS', tacacs: 'TACACS+', ldap: 'LDAP' };

function parseCfg(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(String(v || '{}')) || {}; } catch (e) { return {}; }
}
function serversMap() {
  const out = {};
  db.prepare('SELECT * FROM auth_servers').all().forEach(function (r) { out[r.id] = r; });
  return out;
}
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
    /* 只回传非敏感配置；密钥只给「是否已设置」 */
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
function listServers() {
  const counts = {};
  db.prepare("SELECT server_id, COUNT(*) AS n FROM users WHERE server_id <> '' GROUP BY server_id")
    .all().forEach(function (r) { counts[r.server_id] = r.n; });
  return db.prepare('SELECT * FROM auth_servers ORDER BY created_at').all()
    .map(function (r) { return serverView(r, counts[r.id] || 0); });
}
function canWriteUser(u) { return u.role === 'admin' || (u.perm !== 'ro'); }

/* ---------------- 远程认证：网络传输 + 协议模块 ---------------- */
/* 协议编解码在 worker/auth-protocols.mjs（与 Cloudflare Workers 版共用同一份），
   这里只负责提供 Node 侧的 UDP / TCP 传输实现。 */
let protocolsMod = null;
function loadProtocols() {
  if (!protocolsMod) {
    /* 部署后与本文件同级；从仓库直接跑时在 ../worker/ 下（deploy.sh 会把这份拷到同级） */
    protocolsMod = import('./auth-protocols.mjs').catch(function () {
      return import('../../worker/auth-protocols.mjs');
    });
    /* 加载失败不缓存，便于放好文件后免重启重试 */
    protocolsMod.catch(function () { protocolsMod = null; });
  }
  return protocolsMod;
}

/* 一次 UDP 交互（RADIUS）：发一包、等一包、超时即报错 */
function sendUdp(host, port, bytes, timeoutMs) {
  const dgram = require('node:dgram');
  return new Promise(function (resolve, reject) {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = function (fn, arg) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (e) {}
      fn(arg);
    };
    const timer = setTimeout(function () { finish(reject, new Error('timeout')); }, timeoutMs);
    sock.on('message', function (msg) { finish(resolve, new Uint8Array(msg)); });
    sock.on('error', function (e) { finish(reject, e); });
    sock.send(Buffer.from(bytes), port, host, function (e) { if (e) finish(reject, e); });
  });
}

function openTcp(host, port, opts) {
  const net = require('node:net');
  let tls = require('node:tls');
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    const useTls = !!opts.tls;
    const connectOpts = { host: host, port: port };
    if (useTls) connectOpts.rejectUnauthorized = !opts.insecure;
    const sock = useTls ? tls.connect(connectOpts) : net.connect(connectOpts);
    let buf = Buffer.alloc(0);
    let waiter = null;

    const pump = function () {
      if (!waiter || buf.length < waiter.n) return;
      const w = waiter; waiter = null;
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.resolve(new Uint8Array(out));
    };
    sock.on('data', function (c) { buf = Buffer.concat([buf, c]); pump(); });
    sock.on('error', function (e) { reject(e); });
    sock.setTimeout(opts.timeoutMs || 5000, function () { sock.destroy(); reject(new Error('timeout')); });
    sock.once(useTls ? 'secureConnect' : 'connect', function () {
      resolve({
        write: function (b) {
          return new Promise(function (res) { sock.write(Buffer.from(b), function () { res(); }); });
        },
        read: function (n) {
          if (buf.length >= n) {
            const out = buf.subarray(0, n); buf = buf.subarray(n);
            return Promise.resolve(new Uint8Array(out));
          }
          return new Promise(function (res, rej) { waiter = { n: n, resolve: res, reject: rej }; });
        },
        close: function () { try { sock.destroy(); } catch (e) {} }
      });
    });
  });
}

const AUTH_TRANSPORT = {
  udp: function (host, port, bytes, timeoutMs) { return sendUdp(host, port, bytes, timeoutMs); },
  tcp: function (host, port, opts) { return openTcp(host, port, opts); }
};

/* 用指定认证服务器校验一次口令；返回 { ok, code, message } */
async function remoteAuth(srv, username, password) {
  let P;
  try {
    P = await loadProtocols();
  } catch (e) {
    return { ok: false, code: 'nolib', message: '认证模块 auth-protocols.mjs 未加载：' + (e && e.message) };
  }
  return P.authenticate(AUTH_TRANSPORT, {
    type: srv.type, host: srv.host, port: srv.port || AUTH_DEFAULT_PORT[srv.type] || 0,
    cfg: parseCfg(srv.cfg)
  }, username, password);
}


/* ---------------- 认证服务器：入参校验 ---------------- */
/* 返回 { err } 或 { row }；row 只含待落库字段，secret 未传时沿用库里的旧值
   （前端列表接口拿不到密钥，编辑时留空即表示「不修改」） */
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

/* ---------------- 初始超管 ---------------- */
/* 与 worker/schema.sql 一致：admin / admin888，must_change=1 强制首登改密。
   仅在表为空时写入，改密后重复启动不会回退。 */
(function seedAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return;
  const salt = 'Sa64bc60c760738d3';
  const hash = hashPwd('admin888', salt);
  db.prepare(
    'INSERT INTO users (username, name, role, status, note, salt, hash, must_change, created_at, last_login) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('admin', '超级管理员', 'admin', 'active', '系统初始超级管理员', salt, hash, 1, nowIso(), '');
  console.log('[init] 已创建初始超级管理员 admin / admin888（首次登录需改密）');
})();

/* ---------------- 数据访问 ---------------- */
const stmtSessionJoin =
  'SELECT s.expires_at AS exp, u.username, u.name, u.role, u.status, u.note, u.must_change, u.created_at, u.last_login, ' +
  'u.source, u.perm, u.server_id ' +
  'FROM sessions s JOIN users u ON u.username = s.username WHERE s.token = ?';
const USER_COLS = 'username, name, role, status, note, must_change, created_at, last_login, source, perm, server_id, share_from';

function currentUser(req) {
  const raw = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  if (!m) return null;
  const token = m[1].trim();
  const row = db.prepare(stmtSessionJoin).get(token);
  if (!row) return null;
  if (Date.parse(row.exp) < Date.now()) {
    try { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); } catch (e) {}
    return null;
  }
  if (row.status !== 'active') return null;
  const u = mapUser(row, serversMap());
  u.token = token;
  return u;
}

/* ---------- 共享数据集：share_from 指向数据归属者（一层，创建时已解析成最终 owner） ---------- */
function dataOwner(username) {
  const row = db.prepare('SELECT share_from FROM users WHERE username = ?').get(username);
  return (row && row.share_from) ? row.share_from : username;
}
function shareMembers(owner) {
  return db.prepare('SELECT username, name, created_at FROM users WHERE share_from = ? ORDER BY created_at').all(owner);
}

function readLedger(username) {
  const row = db.prepare('SELECT data FROM ledgers WHERE username = ?').get(dataOwner(username));
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
function pruneLogs() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM ledger_logs').get();
  if (row.n > 5000) {
    db.prepare('DELETE FROM ledger_logs WHERE id <= (SELECT id FROM ledger_logs ORDER BY id DESC LIMIT 1 OFFSET 5000)').run();
  }
}
function writeLedger(username, data, by) {
  const owner = dataOwner(username);
  const oldData = readLedger(owner);
  db.prepare(
    'INSERT INTO ledgers (username, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
  ).run(owner, JSON.stringify(data), nowIso(), by);
  /* 只在真正有变化时记日志（800ms 防抖的重推大多是内容未变） */
  const logs = oldData ? diffLedgerLogs(oldData, data) : [{ kind: 'init', action: 'add', target: '台账', detail: '初始化台账' }];
  if (logs.length) {
    const at = nowIso();
    logs.forEach(function (l) {
      db.prepare('INSERT INTO ledger_logs (username, actor, kind, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(owner, by, l.kind, l.action, l.target || '', l.detail || '', at);
    });
    pruneLogs();
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
function bundleFor(u) {
  const isAdmin = u.role === 'admin';
  const srvMap = serversMap();
  let users;
  if (isAdmin) {
    users = db.prepare('SELECT ' + USER_COLS + ' FROM users ORDER BY created_at').all()
      .map(function (r) { return mapUser(r, srvMap); });
  } else {
    users = [mapUser(u, srvMap)];
  }
  users.forEach(function (x) { x.sharedWith = shareMembers(x.username).map(function (m) { return m.username; }); });
  const ledgers = {};
  if (isAdmin) {
    db.prepare('SELECT ' + USER_COLS + ' FROM users').all().forEach(function (r) {
      const d = readLedger(r.username);          /* 共享成员解析到 owner 的数据 */
      if (d) ledgers[r.username] = d;
    });
  } else {
    const d = readLedger(u.username);
    if (d) ledgers[u.username] = d;
  }
  return {
    user: mapUser(u, srvMap), users: users, ledgers: ledgers, admin: isAdmin,
    canWrite: canWriteUser(u), attachMax: ATTACH_MAX,
    /* 认证服务器清单只给超管（含配置，密钥仅标记是否已设置） */
    authServers: isAdmin ? listServers() : []
  };
}
function activeAdminCount(exclude) {
  const row = exclude
    ? db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND username <> ?").get(exclude)
    : db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get();
  return row ? row.n : 0;
}

/* ---------------- 响应 helper ---------------- */
function sendJson(res, data, status) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status || 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length
  });
  res.end(body);
}
function ok(res, data) { sendJson(res, { ok: true, data: data === undefined ? null : data }); }
function bad(res, msg, status) { sendJson(res, { ok: false, error: msg || '请求无效' }, status || 400); }

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/* ---------------- 首页照片存储 ---------------- */
const PHOTO_EXTS = ['.jpg', '.png', '.webp'];
const PHOTO_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const PHOTO_MAX = 8 * 1024 * 1024;

/* 按文件头判断真实格式，不信任前端声明的 MIME */
function sniffImage(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

/* 当前生效的上传照片（至多一张；清掉其它扩展名，避免探测命中旧图） */
function findStoredPhoto() {
  for (let i = 0; i < PHOTO_EXTS.length; i++) {
    const fp = path.join(PHOTO_DIR, 'hero' + PHOTO_EXTS[i]);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.size > 0) return { file: fp, ext: PHOTO_EXTS[i], size: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {}
  }
  return null;
}

function sendPhoto(req, res, p) {
  const st = p.mtimeMs + ':' + p.size;
  const etag = 'W/"photo-' + Math.floor(p.mtimeMs).toString(16) + '-' + p.size.toString(16) + '"';
  const headers = {
    'content-type': PHOTO_MIME[p.ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'etag': etag,
    'x-content-type-options': 'nosniff'
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some(function (v) { return v.trim() === etag || v.trim() === '*'; })) {
    res.writeHead(304, headers);
    return res.end();
  }
  let buf;
  try { buf = fs.readFileSync(p.file); } catch (e) {
    return sendJson(res, { ok: false, error: '照片读取失败' }, 500);
  }
  headers['content-length'] = buf.length;
  headers['x-photo-stamp'] = st;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/* ---------------- 巡检附件 ---------------- */
/* 附件按「不可猜的随机 id」存放并对外只读：<img src> / <iframe src> 无法携带
   Authorization 头，所以读取接口不校验登录；id 为 24 位随机十六进制（96 bit），
   不泄露即不可枚举。只有上传/删除需要登录。 */
const ATTACH_MAX = 20 * 1024 * 1024;
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
/* 可在浏览器内直接打开的类型（其余一律以附件形式下载，避免 html/svg 之类被 inline 执行） */
const INLINE_MIME = /^(image\/(jpeg|png|webp|gif)|application\/pdf|text\/(plain|csv))/;

function attachExtOf(name, mime) {
  const byName = path.extname(String(name || '')).toLowerCase();
  if (ATTACH_MIME[byName]) return byName;
  const hit = Object.keys(ATTACH_MIME).filter(function (e) { return ATTACH_MIME[e].split(';')[0] === mime; })[0];
  return hit || '';
}
function safeFileName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 120);
  return base || 'file';
}
function contentDisposition(kind, name) {
  const ascii = safeFileName(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return kind + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safeFileName(name));
}
/* 附件在磁盘上的真实扩展名。不能只看文件名后缀：
   前端会把图片统一重编码成 JPEG（文件名可能仍是 xx.png），服务端按文件头存成 .jpg，
   所以「存盘用的 ext」必须持久化，读取时优先用它，否则会去找不存在的 <id>.png。 */
function attachExtResolve(row) {
  const stored = String(row.ext || '').toLowerCase();
  if (stored && ATTACH_MIME[stored]) return stored;
  return attachExtOf(row.name, String(row.mime || '').split(';')[0]) || '';
}
/* 定位附件文件：先按记录里的 ext，再按 mime 推断，最后扫目录兜底（兼容历史脏数据） */
function findAttachFile(row) {
  const tries = [];
  const byRow = attachExtResolve(row);
  if (byRow) tries.push(byRow);
  const byMime = Object.keys(ATTACH_MIME).filter(function (e) {
    return ATTACH_MIME[e].split(';')[0] === String(row.mime || '').split(';')[0];
  })[0];
  if (byMime && tries.indexOf(byMime) < 0) tries.push(byMime);
  for (let i = 0; i < tries.length; i++) {
    const fp = path.join(UPLOAD_DIR, row.id + tries[i]);
    try { if (fs.statSync(fp).isFile()) return fp; } catch (e) {}
  }
  try {
    const hit = fs.readdirSync(UPLOAD_DIR).filter(function (f) { return f.indexOf(row.id + '.') === 0; })[0];
    if (hit) return path.join(UPLOAD_DIR, hit);
  } catch (e) {}
  return '';
}
function serveAttachment(req, res, row) {
  const fp = findAttachFile(row);
  if (!fp) return sendJson(res, { ok: false, error: '附件已不存在' }, 404);
  let st;
  try { st = fs.statSync(fp); } catch (e) { return sendJson(res, { ok: false, error: '附件已不存在' }, 404); }
  const realExt = path.extname(fp).toLowerCase();
  const mime = ATTACH_MIME[realExt] || row.mime || 'application/octet-stream';
  const inline = INLINE_MIME.test(mime);
  const etag = 'W/"att-' + row.id + '-' + st.size.toString(16) + '"';
  /* 下载文件名跟随真实扩展名，避免「下了个 .png 打不开」 */
  let dlName = safeFileName(row.name);
  if (realExt && ATTACH_MIME[realExt] && path.extname(dlName).toLowerCase() !== realExt) {
    dlName = dlName.replace(/\.[^.]*$/, '') + realExt;
  }
  const headers = {
    'content-type': mime,
    'cache-control': 'private, max-age=86400',
    'etag': etag,
    'x-content-type-options': 'nosniff',
    'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', dlName)
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some(function (v) { return v.trim() === etag; })) {
    res.writeHead(304, headers);
    return res.end();
  }
  let buf;
  try { buf = fs.readFileSync(fp); } catch (e) { return sendJson(res, { ok: false, error: '附件读取失败' }, 500); }
  headers['content-length'] = buf.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/* ---------------- API 路由 ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/api';
  const method = req.method.toUpperCase();

  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try {
      const raw = await readBody(req);
      body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    } catch (e) { return bad(res, '请求体不是合法 JSON'); }
  }

  /* --- 登录 --- */
  if (p === '/api/auth/login' && method === 'POST') {
    const username = normName(body.username);
    const password = String(body.password || '');
    if (!username || !password) return bad(res, '请输入用户名与密码。');
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    /* 账号不存在与密码错误统一提示，避免账号枚举 */
    if (!u) return bad(res, '用户名或密码不正确。', 401);
    /* 口令来源：本地哈希，或转发给 RADIUS / TACACS+ / LDAP 服务器校验 */
    const source = u.source || 'local';
    if (source === 'local') {
      if (hashPwd(password, u.salt) !== u.hash) return bad(res, '用户名或密码不正确。', 401);
    } else {
      /* 远程账号先判停用，避免拿已停用账号去撞认证服务器（可能触发锁定计数） */
      if (u.status !== 'active') return bad(res, '该账号已停用，请联系超级管理员。', 403);
      const srv = db.prepare('SELECT * FROM auth_servers WHERE id = ?').get(u.server_id || '');
      if (!srv || !srv.enabled) return bad(res, '认证服务暂时不可用，请联系超级管理员。', 503);
      const r = await remoteAuth(srv, u.username, password);
      if (!r.ok) {
        /* 只有明确的「口令不对」才回统一话术；连不上/密钥不匹配属于配置问题，给管理员可读的提示 */
        if (r.code === 'reject' || r.code === 'nouser') return bad(res, '用户名或密码不正确。', 401);
        console.warn('[auth] 远程认证失败 ' + username + ' @' + srv.type + ':' + srv.host + ' → ' + r.code + ' ' + r.message);
        return bad(res, '认证服务暂时不可用（' + r.message + '），请联系超级管理员。', 502);
      }
    }
    if (u.status !== 'active') return bad(res, '该账号已停用，请联系超级管理员。', 403);

    const token = newToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    db.prepare('INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, u.username, nowIso(), exp);
    db.prepare('UPDATE users SET last_login = ? WHERE username = ?').run(nowIso(), u.username);
    try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso()); } catch (e) {}

    const payload = bundleFor(u);
    payload.token = token;
    return ok(res, payload);
  }

  /* --- 首页照片：读取 / 上传 / 移除 ---
     首页本身没有账号体系，故不要求登录；但仅接受同源请求（校验 Origin），
     且只接受文件头合法的 jpg/png/webp。照片存 DATA_DIR/photo（挂载卷），
     重建镜像不丢；前端不做任何本机缓存，换图后所有设备刷新即生效。 */
  if (p === '/api/photo/current' && (method === 'GET' || method === 'HEAD')) {
    const cur = findStoredPhoto();
    if (!cur) return sendJson(res, { ok: false, error: '未设置照片' }, 404);
    return sendPhoto(req, res, cur);
  }

  if (p === '/api/photo' && method === 'POST') {
    const origin = String(req.headers.origin || '');
    if (origin) {
      let oh = '';
      try { oh = new URL(origin).host; } catch (e) { oh = ''; }
      if (oh !== String(req.headers.host || '')) return bad(res, '仅允许本站页面上传照片', 403);
    }
    const m = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.data || ''));
    if (!m) return bad(res, '不是有效的图片数据（需为 jpg / png / webp）');
    const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    if (buf.length < 1024) return bad(res, '图片数据过小，已忽略');
    if (buf.length > PHOTO_MAX) return bad(res, '图片超过 8MB，请压缩后再上传');
    const ext = sniffImage(buf);
    if (!ext) return bad(res, '文件内容不是有效的 jpg / png / webp 图片');
    try {
      PHOTO_EXTS.forEach(function (e) {
        if (e === ext) return;
        try { fs.unlinkSync(path.join(PHOTO_DIR, 'hero' + e)); } catch (err) {}
      });
      /* 先写临时文件再改名，避免读到写了一半的图 */
      const tmp = path.join(PHOTO_DIR, 'hero' + ext + '.tmp');
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(PHOTO_DIR, 'hero' + ext));
      cache.clear();
    } catch (e) {
      return bad(res, '保存失败：' + (e && e.message ? e.message : '磁盘写入错误'), 500);
    }
    return ok(res, { url: '/api/photo/current', size: buf.length, ext: ext, at: Date.now() });
  }

  if (p === '/api/photo' && method === 'DELETE') {
    const cur = findStoredPhoto();
    if (!cur) return ok(res, { removed: false });
    try { fs.unlinkSync(cur.file); } catch (e) { return bad(res, '删除失败：' + (e && e.message ? e.message : '磁盘错误'), 500); }
    cache.clear();
    return ok(res, { removed: true });
  }

  /* --- 附件读取（公开、按不可猜 id） --- */
  const ma = /^\/api\/attach\/([A-Za-z0-9]{8,40})$/.exec(p);
  if (ma && (method === 'GET' || method === 'HEAD')) {
    const row = db.prepare('SELECT id, name, mime, size, ext FROM attachments WHERE id = ?').get(ma[1]);
    if (!row) return sendJson(res, { ok: false, error: '附件已删除' }, 404);
    return serveAttachment(req, res, row);
  }

  /* --- 以下均需登录 --- */
  const me = currentUser(req);
  if (!me) return bad(res, '登录已失效，请重新登录。', 401);
  const isAdmin = me.role === 'admin';

  if (p === '/api/auth/me' && method === 'GET') return ok(res, bundleFor(me));

  if (p === '/api/auth/logout' && method === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(me.token);
    return ok(res, null);
  }

  if (p === '/api/auth/password' && method === 'POST') {
    const oldPwd = String(body.oldPassword || '');
    const newPwd = String(body.newPassword || '');
    if (newPwd.length < 6) return bad(res, '新密码至少 6 位');
    /* 远程账号的口令由 RADIUS / TACACS+ / LDAP 掌管，本系统改不了 */
    if ((me.source || 'local') !== 'local') {
      return bad(res, '该账号使用「' + (AUTH_LABEL[me.source] || me.source) + '」认证，密码请到对应的认证系统修改。', 400);
    }
    const row = db.prepare('SELECT salt, hash FROM users WHERE username = ?').get(me.username);
    if (!row) return bad(res, '账号不存在', 404);
    if (hashPwd(oldPwd, row.salt) !== row.hash) return bad(res, '当前密码不正确');
    const salt = newSalt();
    db.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 0 WHERE username = ?')
      .run(salt, hashPwd(newPwd, salt), me.username);
    /* 保留当前会话，踢掉其它设备上的会话 */
    db.prepare('DELETE FROM sessions WHERE username = ? AND token <> ?').run(me.username, me.token);
    return ok(res, null);
  }

  /* --- 巡检附件：上传 / 删除（需登录；读取见上方公开路由） --- */
  if (p === '/api/attach' && method === 'POST') {
    if (!canWriteUser(me)) return bad(res, '当前账号为只读权限，不能上传附件。', 403);
    const name = safeFileName(body.name);
    const mime = String(body.mime || '').toLowerCase().split(';')[0].trim();
    const raw = String(body.data || '');
    const m = /^data:[^,]*,([A-Za-z0-9+/=\s]+)$/.exec(raw) || /^([A-Za-z0-9+/=\s]+)$/.exec(raw);
    if (!m) return bad(res, '附件数据格式不正确');
    const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    if (!buf.length) return bad(res, '附件内容为空');
    if (buf.length > ATTACH_MAX) {
      return bad(res, '单个附件不能超过 ' + Math.round(ATTACH_MAX / 1024 / 1024) + 'MB');
    }
    /* 图片按文件头纠正类型与扩展名，防止把任意内容伪装成图片/PDF 内联执行 */
    const sniffed = sniffImage(buf);
    let finalMime, ext;
    if (sniffed) {
      finalMime = PHOTO_MIME[sniffed];
      ext = sniffed;
    } else {
      ext = attachExtOf(name, mime);
      if (!ext) return bad(res, '不支持的文件类型（支持图片、PDF、Office、文本、压缩包）');
      finalMime = ATTACH_MIME[ext].split(';')[0];
    }
    const id = randHex(12);
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, id + ext), buf);
      db.prepare('INSERT INTO attachments (id, name, mime, size, owner, created_at, ext) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, finalMime, buf.length, me.username, nowIso(), ext);
    } catch (e) {
      return bad(res, '附件保存失败：' + (e && e.message ? e.message : '磁盘错误'), 500);
    }
    return ok(res, {
      id: id, name: name, mime: finalMime,
      size: buf.length, url: '/api/attach/' + id
    });
  }

  const mAt = /^\/api\/attach\/([A-Za-z0-9]{8,40})$/.exec(p);
  if (mAt && method === 'DELETE') {
    if (!canWriteUser(me)) return bad(res, '当前账号为只读权限，不能删除附件。', 403);
    const row = db.prepare('SELECT id, name, mime, owner, ext FROM attachments WHERE id = ?').get(mAt[1]);
    if (!row) return ok(res, { removed: false });
    if (!isAdmin && row.owner !== me.username) return bad(res, '无权删除该附件', 403);
    const fp = findAttachFile(row);
    if (fp) { try { fs.unlinkSync(fp); } catch (e) {} }
    db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    return ok(res, { removed: true });
  }

  /* --- 台账读写：scope = 用户名；超管可读写任何人 --- */
  if (p === '/api/ledger' && method === 'GET') return ok(res, bundleFor(me));

  if (p === '/api/ledger' && method === 'PUT') {
    if (!canWriteUser(me)) return bad(res, '当前账号为只读权限，不能修改台账。', 403);
    const scope = normName(body.scope);
    if (!scope) return bad(res, '缺少数据范围');
    if (!isAdmin && scope !== me.username) return bad(res, '无权写入该账号的台账', 403);
    if (isAdmin) {
      const exists = db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(scope);
      if (!exists) return bad(res, '目标账号不存在', 404);
    }
    writeLedger(scope, sanitizeLedger(body.data), me.username);
    return ok(res, { scope: scope, updatedAt: nowIso() });
  }

  /* --- 数据变更日志：按数据归属（共享数据集共用一份历史）查询 --- */
  if (p === '/api/logs' && method === 'GET') {
    const req = normName(url.searchParams.get('username') || me.username);
    if (!db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(req)) return bad(res, '用户不存在', 404);
    if (!isAdmin && req !== me.username) return bad(res, '无权查看该账号的数据日志', 403);
    const owner = dataOwner(req);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500);
    const rows = db.prepare('SELECT actor, kind, action, target, detail, at FROM ledger_logs WHERE username = ? ORDER BY id DESC LIMIT ?')
      .all(owner, limit);
    return ok(res, { owner: owner, logs: rows });
  }

  /* --- 认证服务器管理（仅超管）：远程用户的账号校验由此类服务器完成 --- */
  if (p === '/api/auth-servers' && method === 'GET') {
    if (!isAdmin) return bad(res, '仅超级管理员可查看认证服务器', 403);
    return ok(res, { servers: listServers() });
  }

  if (p === '/api/auth-servers' && method === 'POST') {
    if (!isAdmin) return bad(res, '仅超级管理员可新增认证服务器', 403);
    const v = ensureServerInput(body, null);
    if (v.err) return bad(res, v.err);
    const id = 'srv' + randHex(5);
    db.prepare(
      'INSERT INTO auth_servers (id, name, type, host, port, enabled, cfg, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, v.row.name, v.row.type, v.row.host, v.row.port, v.row.enabled, v.row.cfg, nowIso(), nowIso());
    return ok(res, { server: serverView(db.prepare('SELECT * FROM auth_servers WHERE id = ?').get(id), 0) });
  }

  /* 测试连接：既支持「已保存的服务器 id」，也支持用弹窗里尚未保存的配置直接试 */
  if (p === '/api/auth-servers/test' && method === 'POST') {
    if (!isAdmin) return bad(res, '仅超级管理员可测试认证服务器', 403);
    const sid = String(body.id || '').trim();
    const base = sid ? db.prepare('SELECT * FROM auth_servers WHERE id = ?').get(sid) : null;
    if (sid && !base) return bad(res, '认证服务器不存在', 404);
    const v = ensureServerInput(body, base);
    if (v.err) return bad(res, v.err);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return bad(res, '请填写用于测试的账号与密码');
    const r = await remoteAuth({
      type: v.row.type, host: v.row.host, port: v.row.port, cfg: v.row.cfg
    }, username, password);
    console.log('[auth-test] ' + v.row.type + '://' + v.row.host + ':' + v.row.port +
      ' user=' + username + ' → ' + (r.ok ? 'OK' : 'FAIL ' + r.code));
    return ok(res, { ok: !!r.ok, code: r.code, message: r.message });
  }

  const msv = /^\/api\/auth-servers\/([A-Za-z0-9_-]{4,40})$/.exec(p);
  if (msv) {
    if (!isAdmin) return bad(res, '仅超级管理员可修改认证服务器', 403);
    const srow = db.prepare('SELECT * FROM auth_servers WHERE id = ?').get(msv[1]);
    if (!srow) return bad(res, '认证服务器不存在', 404);

    if (method === 'PATCH') {
      const v = ensureServerInput(body, srow);
      if (v.err) return bad(res, v.err);
      db.prepare('UPDATE auth_servers SET name = ?, type = ?, host = ?, port = ?, enabled = ?, cfg = ?, updated_at = ? WHERE id = ?')
        .run(v.row.name, v.row.type, v.row.host, v.row.port, v.row.enabled, v.row.cfg, nowIso(), srow.id);
      /* 类型变了要同步改绑该服务器的账号来源标记，否则登录会走错分支 */
      if (v.row.type !== srow.type) {
        db.prepare('UPDATE users SET source = ? WHERE server_id = ?').run(v.row.type, srow.id);
      }
      return ok(res, { server: serverView(db.prepare('SELECT * FROM auth_servers WHERE id = ?').get(srow.id), 0) });
    }

    if (method === 'DELETE') {
      const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE server_id = ?').get(srow.id).n;
      if (n > 0) return bad(res, '仍有 ' + n + ' 个账号使用该认证服务器，请先改绑或删除这些账号');
      db.prepare('DELETE FROM auth_servers WHERE id = ?').run(srow.id);
      return ok(res, null);
    }
    return bad(res, '不支持的请求方法', 405);
  }

  /* --- 用户管理（仅超管） --- */
  if (p === '/api/users' && method === 'GET') {
    if (!isAdmin) return bad(res, '仅超级管理员可查看用户列表', 403);
    const smap = serversMap();
    const users = db.prepare('SELECT ' + USER_COLS + ' FROM users ORDER BY created_at').all()
      .map(function (r) { return mapUser(r, smap); });
    return ok(res, { users: users });
  }

  if (p === '/api/users' && method === 'POST') {
    if (!isAdmin) return bad(res, '仅超级管理员可创建用户', 403);
    const username = normName(body.username);
    const name = String(body.name || '').trim();
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!validUsername(username)) return bad(res, '用户名需为 3–32 位字母、数字、下划线、点或连字符');
    if (!name) return bad(res, '请填写显示名称');
    if (db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(username)) {
      return bad(res, '用户名「' + username + '」已存在');
    }
    /* 权限：只读 ro 不能改台账；超管恒为读写 */
    const perm = role === 'admin' ? 'rw' : (body.perm === 'ro' ? 'ro' : 'rw');
    /* 账号来源：指定认证服务器即为远程账号，类型取服务器自身的 type（不信任前端传值） */
    const serverId = String(body.serverId || '').trim();
    let source = 'local';
    if (serverId) {
      const srv = db.prepare('SELECT * FROM auth_servers WHERE id = ?').get(serverId);
      if (!srv) return bad(res, '所选认证服务器不存在');
      if (!srv.enabled) return bad(res, '所选认证服务器已停用');
      source = srv.type;
    }

    /* 数据集：shareFrom = 与该用户共用同一份台账（双向同步），不复制数据；
       来源本身也是共享成员时，直接挂到数据归属者，避免链式引用 */
    let shareFrom = '';
    if (body.shareFrom) {
      const src = normName(body.shareFrom);
      const srcRow = db.prepare('SELECT * FROM users WHERE username = ?').get(src);
      if (!srcRow) return bad(res, '要共享数据的来源用户不存在');
      shareFrom = srcRow.share_from || src;
      if (role === 'admin' && shareFrom !== username) {
        return bad(res, '超级管理员维护全局数据，不参与共享数据集');
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
        if (pwd.length < 6) return bad(res, '密码至少 6 位');
        salt = newSalt();
        hash = hashPwd(pwd, salt);
        mustChange = 1;
      }
    } else if (body.password) {
      return bad(res, '远程账号的密码由「' + AUTH_LABEL[source] + '」服务器校验，请不要在本地设置密码');
    }

    db.prepare(
      'INSERT INTO users (username, name, role, status, note, salt, hash, must_change, created_at, source, perm, server_id, share_from) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(username, name, role, 'active', String(body.note || ''), salt, hash, mustChange, nowIso(), source, perm, serverId, shareFrom);
    /* 共享成员不写数据（用的是 owner 的台账）；普通初始化才落 body.data */
    if (!shareFrom && body.data) writeLedger(username, sanitizeLedger(body.data), me.username);
    return ok(res, {
      user: mapUser(db.prepare('SELECT ' + USER_COLS + ' FROM users WHERE username = ?').get(username), serversMap())
    });
  }

  const mu = /^\/api\/users\/([^/]+)$/.exec(p);
  if (mu) {
    const target = normName(decodeURIComponent(mu[1]));
    if (!isAdmin) return bad(res, '仅超级管理员可修改用户', 403);
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(target);
    if (!row) return bad(res, '用户不存在', 404);

    if (method === 'PATCH') {
      const name = body.name == null ? row.name : String(body.name).trim();
      const role = body.role == null ? row.role : (body.role === 'admin' ? 'admin' : 'user');
      const status = body.status == null ? row.status : (body.status === 'disabled' ? 'disabled' : 'active');
      const note = body.note == null ? (row.note || '') : String(body.note);
      const perm = role === 'admin' ? 'rw' : (body.perm == null ? (row.perm || 'rw') : (body.perm === 'ro' ? 'ro' : 'rw'));
      const losingAdmin = row.role === 'admin' && row.status === 'active' && (role !== 'admin' || status !== 'active');
      if (losingAdmin && activeAdminCount(target) === 0) {
        return bad(res, '至少需要保留一个启用的超级管理员');
      }

      /* 来源变更：body.serverId 传空串表示改回本地账号 */
      let source = row.source || 'local';
      let serverId = row.server_id || '';
      let sourceChanged = false;
      if (body.serverId !== undefined) {
        const sid = String(body.serverId || '').trim();
        if (sid) {
          const srv = db.prepare('SELECT * FROM auth_servers WHERE id = ?').get(sid);
          if (!srv) return bad(res, '所选认证服务器不存在');
          if (!srv.enabled) return bad(res, '所选认证服务器已停用');
          source = srv.type;
        } else {
          source = 'local';
        }
        serverId = sid;
        sourceChanged = (source !== (row.source || 'local')) || (serverId !== (row.server_id || ''));
      }
      /* 从远程改回本地时必须给一个本地口令，否则这个账号将无法登录 */
      const wantsLocalWithoutPwd = source === 'local' && !row.hash && !(body.password && String(body.password).length);
      if (wantsLocalWithoutPwd) return bad(res, '改为本地账号时需要设置初始密码（至少 6 位）');
      if (source !== 'local' && body.password) {
        return bad(res, '远程账号的密码由「' + AUTH_LABEL[source] + '」服务器校验，不能在本地重置');
      }

      db.prepare('UPDATE users SET name = ?, role = ?, status = ?, note = ?, perm = ?, source = ?, server_id = ? WHERE username = ?')
        .run(name, role, status, note, perm, source, serverId, target);
      if (body.password != null && String(body.password).length) {
        const np = String(body.password);
        if (np.length < 6) return bad(res, '密码至少 6 位');
        const salt = newSalt();
        db.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 1 WHERE username = ?')
          .run(salt, hashPwd(np, salt), target);
        db.prepare('DELETE FROM sessions WHERE username = ?').run(target);
      } else if (sourceChanged) {
        /* 换了认证来源后旧会话的权限语义已变，强制重新登录 */
        db.prepare('DELETE FROM sessions WHERE username = ? AND username <> ?').run(target, me.username);
        if (source !== 'local') {
          db.prepare('UPDATE users SET salt = ?, hash = ? WHERE username = ?').run('', '', target);
        }
      }
      return ok(res, {
        user: mapUser(db.prepare('SELECT ' + USER_COLS + ' FROM users WHERE username = ?').get(target), serversMap())
      });
    }

    if (method === 'DELETE') {
      if (target === me.username) return bad(res, '不能删除当前登录账号');
      if (row.role === 'admin' && row.status === 'active' && activeAdminCount(target) === 0) {
        return bad(res, '至少保留一个启用的超级管理员，无法删除');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        /* 一并清理该账号的附件文件与记录，避免磁盘残留 */
        const atts = db.prepare('SELECT id, name, mime, ext FROM attachments WHERE owner = ?').all(target);
        atts.forEach(function (a) {
          const fp = findAttachFile(a);
          if (fp) { try { fs.unlinkSync(fp); } catch (e) {} }
        });
        db.prepare('DELETE FROM attachments WHERE owner = ?').run(target);
        db.prepare('DELETE FROM sessions WHERE username = ?').run(target);
        /* 共享数据集处理：删的是数据归属者且有成员 → 台账与日志转给最早的成员；
           删的是成员 → 数据不动；无成员的普通账号 → 连台账一起删 */
        if (!(row.share_from || '').length) {
          const members = shareMembers(target);
          if (members.length) {
            const heir = members[0].username;
            db.prepare('UPDATE ledgers SET username = ? WHERE username = ?').run(heir, target);
            db.prepare('UPDATE ledger_logs SET username = ? WHERE username = ?').run(heir, target);
            db.prepare('UPDATE users SET share_from = ? WHERE share_from = ?').run(heir, target);
            /* 归属者本人不再指向别人 */
            db.prepare("UPDATE users SET share_from = '' WHERE username = ?").run(heir);
          } else {
            db.prepare('DELETE FROM ledgers WHERE username = ?').run(target);
          }
        }
        db.prepare('DELETE FROM users WHERE username = ?').run(target);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return ok(res, null);
    }
    return bad(res, '不支持的请求方法', 405);
  }

  /* --- 高德地图 WebService 代理（地点搜索 / 地理编码） ---
     restapi.amap.com 不返回跨域头，浏览器无法直连，由服务端代为请求；
     返回结构与原腾讯 WS 保持一致（status:0 + data/result），前端契约不变：
       suggestion → 高德 inputtips（提示检索）
       geocode    → 高德 geocode/geo（地理编码）
     AMap status 为字符串 "1"/"0"，infocode 10000=成功；错误时给出可读中文。 */
  if (p === '/api/place/search' && method === 'GET') {
    const akey = process.env.AMAP_KEY || DEFAULT_AMAP_KEY;
    const type = url.searchParams.get('type') === 'geocode' ? 'geocode' : 'suggestion';
    const amapParams = new URLSearchParams({ key: akey });
    let kwText = '';
    if (type === 'geocode') {
      kwText = String(url.searchParams.get('address') || '').trim().slice(0, 120);
      if (!kwText) return bad(res, '请输入地址');
      amapParams.set('address', kwText);
    } else {
      kwText = String(url.searchParams.get('keyword') || '').trim().slice(0, 100);
      if (!kwText) return bad(res, '请输入关键词');
      amapParams.set('keywords', kwText);
      const region = String(url.searchParams.get('region') || '').trim().slice(0, 40);
      if (region) { amapParams.set('city', region); amapParams.set('citylimit', 'false'); }
    }
    const amapPath = type === 'geocode' ? '/v3/geocode/geo' : '/v3/assistant/inputtips';
    const ctrl = new AbortController();
    const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 10000);
    try {
      const r = await fetch('https://restapi.amap.com' + amapPath + '?' + amapParams.toString(), { signal: ctrl.signal });
      const j = await r.json();
      if (String(j.status) !== '1') {
        return ok(res, { status: 1, message: amapErrMsg(j.infocode, j.info) });
      }
      if (type === 'geocode') {
        const g = (j.geocodes || [])[0];
        if (!g || !g.location) return ok(res, { status: 1, message: '未找到匹配地址' });
        const ll = String(g.location || '').split(',');
        return ok(res, {
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
      return ok(res, { status: 0, data: list });
    } catch (e) {
      return bad(res, '检索服务连接失败，请稍后重试', 502);
    } finally {
      clearTimeout(timer);
    }
  }

  return bad(res, '接口不存在', 404);
}

/* ---------------- 地图资源中转（/_tmap/<host>/<path>） ----------------
   内网终端访问不到外网时，浏览器地图改走本代理：
   SDK 脚本经本代理返回时会把硬编码的地图域名整体改写为「页面同源主机 + /_tmap/<host>/」，
   后续样式 / 瓦片 / 接口请求自动落回本站，由服务器转发（实时转发不落盘，
   地图数据始终取自官方，规避离线打包的数据许可与更新问题）。
   2026-10 换用高德：新增 amap.com / autonavi.com 白名单；高德瓦片模板含
   webrd0{1,2,3,4} 动态展开与 "://" 字符串拼接，改写必须带上页面主机做成绝对地址。 */
const TMAP_HOST_RE = /^([a-z0-9-]+\.)*(qq\.com|gtimg\.com|qpic\.cn|amap\.com|autonavi\.com)$/;
function tmapTargetOf(url) {
  const rest = url.pathname.slice('/_tmap/'.length);
  const slash = rest.indexOf('/');
  if (slash < 1) return null;
  const host = rest.slice(0, slash).toLowerCase();
  if (!TMAP_HOST_RE.test(host)) return null;
  return { host: host, path: rest.slice(slash) + url.search };
}
/* JS 文本中的地图域名改写。pageHost = 当前请求的页面主机（req.headers.host）。
   腾讯写法（https:// 与 //host）沿用相对路径改写；高德写法（"://" 拼接、
   webrd0{1,2,3,4}.is.autonavi.com 模板）改写为页面同源绝对地址，保证
   Blob Worker 内的相对路径也能解析。 */
function tmapRewriteJs(text, pageHost) {
  const ph = String(pageHost || '').replace(/[^a-zA-Z0-9.\-:]/g, '') || 'localhost';
  /* ① 绝对地址 http(s)://host → 页面同源绝对地址（高德 Blob Worker 内也能解析） */
  text = text.replace(
    /(https?:\/\/)((?:[a-z0-9{},\-]+\.)+(?:qq\.com|gtimg\.com|qpic\.cn|amap\.com|autonavi\.com))/gi,
    function (m0, sch, host) { return 'https://' + ph + '/_tmap/' + host; });
  /* ② 协议相对 //host → 站内相对路径（主线程场景） */
  text = text.replace(
    /([^:\/])\/\/((?:[a-z0-9{},\-]+\.)*(?:qq\.com|gtimg\.com|qpic\.cn|amap\.com|autonavi\.com))/gi,
    function (m0, c, host) { return c + '/_tmap/' + host; });
  /* ③ 高德字符串拼接 ji+"://webrd0{1,2,3,4}.is.autonavi.com → 保留 scheme、替换主机 */
  text = text.replace(
    /(:\/\/)((?:[a-z0-9{},\-]+\.)+(?:amap\.com|autonavi\.com))/g,
    function (m0, c, host) { return c + ph + '/_tmap/' + host; });
  return text;
}
async function tmapGljs(req, res, url) {
  const key = String(url.searchParams.get('key') || '').trim();
  const target = 'https://map.qq.com/api/gljs?v=1.exp&libraries=service' +
    (key ? '&key=' + encodeURIComponent(key) : '');
  const r = await fetch(target, { headers: { referer: 'https://map.qq.com/' } });
  let text = await r.text();
  text = tmapRewriteJs(text, req.headers.host);
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(r.status, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff'
  });
  res.end(buf);
}
async function tmapProxy(req, res, url) {
  const t = tmapTargetOf(url);
  if (!t) return bad(res, '代理目标不在允许的域名清单内', 403);
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    return bad(res, 'Method Not Allowed', 405);
  }
  const headers = {
    host: t.host,
    referer: 'https://' + t.host + '/',
    'user-agent': req.headers['user-agent'] || 'inspection-ledger-tmap-proxy'
  };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  const ctrl = new AbortController();
  const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 30000);
  try {
    const r = await fetch('https://' + t.host + t.path, {
      method: req.method === 'HEAD' ? 'GET' : req.method,
      headers: headers,
      body: req.method === 'POST' ? await readBody(req) : undefined,
      signal: ctrl.signal
    });
    const h = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
    const ct = r.headers.get('content-type');
    if (ct) h['content-type'] = ct;
    if (req.method === 'HEAD') { res.writeHead(r.status, h); return res.end(); }
    const ab = await r.arrayBuffer();
    let buf = Buffer.from(ab);
    /* JS 资源同样做域名改写：SDK 主包运行时会按硬编码域名拼瓦片/样式请求 */
    if (ct && /javascript/i.test(ct) && buf.length < 20 * 1024 * 1024) {
      let text = tmapRewriteJs(buf.toString('utf8'), req.headers.host);
      buf = Buffer.from(text, 'utf8');
      h['content-length'] = String(buf.length);
    }
    res.writeHead(r.status, h);
    res.end(buf);
  } catch (e) {
    if (!res.headersSent) bad(res, '地图资源转发失败：' + (e && e.message ? e.message : '网络不可达'), 502);
    else res.end();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 静态资源 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;
const BLOCKED = /^\/(server\.js|auth-protocols\.mjs|package(-lock)?\.json|Dockerfile|docker-compose\.yml|\.dockerignore|data\/|node_modules\/|\.git\/|tests\/|worker\/)/;

const cache = new Map(); // key: file:mtime:size -> { buf, gz, br }
const CACHE_MAX = 40;

function cacheGet(fp, st) {
  const key = fp + ':' + st.mtimeMs + ':' + st.size;
  let hit = cache.get(key);
  if (hit) return hit;
  const buf = fs.readFileSync(fp);
  hit = { buf: buf, gz: null, br: null };
  if (buf.length > 1024) {
    try {
      hit.gz = zlib.gzipSync(buf, { level: 6 });
      hit.br = zlib.brotliCompressSync(buf, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length }
      });
    } catch (e) {}
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, hit);
  return hit;
}

function pickEncoding(req, hit) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae) && hit.br) return 'br';
  if (/\bgzip\b/.test(ae) && hit.gz) return 'gz';
  return null;
}

async function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (!path.extname(rel)) rel += '.html';       /* 与 Cloudflare 行为一致：/x → /x.html */
  if (BLOCKED.test(rel)) return serve404(req, res);

  const fp = path.resolve(APP_DIR, '.' + rel);
  if (fp !== APP_DIR && !fp.startsWith(APP_DIR + path.sep)) return serve404(req, res);

  let st;
  try {
    st = await fsp.stat(fp);
    if (!st.isFile()) return serve404(req, res);
  } catch (e) {
    return serve404(req, res);
  }

  const ext = path.extname(fp).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const hit = cacheGet(fp, st);
  const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';

  /* 页面必须回源校验（304 只几十字节），静态资源短缓存，便于内部改版即时生效 */
  const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.ico'];
  const cc = ext === '.html'
    ? 'no-cache'
    : (IMG_EXT.indexOf(ext) >= 0 ? 'no-cache'                       /* 图片换图即时生效，靠 ETag 304 省流量 */
      : (rel.indexOf('/assets/') === 0 ? 'public, max-age=31536000, immutable'  /* 带 ?v= 的数据文件走长缓存 */
        : 'public, max-age=3600'));

  const headers = {
    'content-type': mime,
    'cache-control': cc,
    'etag': etag,
    'last-modified': st.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
  };

  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some(function (v) { return v.trim() === etag || v.trim() === '*'; })) {
    res.writeHead(304, headers);
    return res.end();
  }

  const enc = COMPRESSIBLE.test(mime) ? pickEncoding(req, hit) : null;
  let body = hit.buf;
  if (enc === 'br') { body = hit.br; headers['content-encoding'] = 'br'; }
  else if (enc === 'gz') { body = hit.gz; headers['content-encoding'] = 'gzip'; }
  headers['content-length'] = body.length;
  if (enc) headers['vary'] = 'accept-encoding';

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function serve404(req, res) {
  fs.readFile(path.join(APP_DIR, '404.html'), function (err, buf) {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(404, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

/* ---------------- 服务器 ---------------- */
let TLS_ON = false;
let tlsOpts = null;
try {
  if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
    tlsOpts = {
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
      minVersion: 'TLSv1.2',
      honorCipherOrder: true
    };
    TLS_ON = true;
  }
} catch (e) {
  console.error('[tls] 证书读取失败，退回 HTTP：' + (e && e.message));
}

function handler(req, res) {
  const started = Date.now();
  const url = new URL(req.url, (TLS_ON ? 'https' : 'http') + '://' + (req.headers.host || 'localhost'));

  /* 强制 HTTPS（1 年）：TLS 终止在本进程，无需代理头协商 */
  if (TLS_ON) res.setHeader('strict-transport-security', 'max-age=31536000');

  res.on('finish', function () {
    const line = req.method + ' ' + url.pathname + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms';
    if (res.statusCode >= 400) console.log('[warn] ' + line); else console.log(line);
  });

  if (url.pathname === '/healthz') {
    return sendJson(res, { ok: true, db: DB_FILE, uptime: Math.round(process.uptime()) });
  }

  if (url.pathname === '/_tmap/gljs') {
    return tmapGljs(req, res, url).catch(function (e) {
      console.error('[error] tmap-gljs ' + (e && e.stack ? e.stack : e));
      if (!res.headersSent) bad(res, '地图引导脚本转发失败', 502);
      else res.end();
    });
  }
  if (url.pathname.indexOf('/_tmap/') === 0) {
    return tmapProxy(req, res, url).catch(function (e) {
      console.error('[error] tmap-proxy ' + (e && e.stack ? e.stack : e));
      if (!res.headersSent) bad(res, '地图资源转发失败', 502);
      else res.end();
    });
  }

  if (url.pathname === '/api' || url.pathname.indexOf('/api/') === 0) {
    return handleApi(req, res, url).catch(function (e) {
      console.error('[error] ' + (e && e.stack ? e.stack : e));
      if (!res.headersSent) bad(res, '服务器内部错误：' + (e && e.message ? e.message : '未知'), 500);
      else res.end();
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  serveStatic(req, res, url).catch(function (e) {
    console.error('[error] static ' + (e && e.stack ? e.stack : e));
    if (!res.headersSent) serve404(req, res); else res.end();
  });
}

const server = TLS_ON ? https.createServer(tlsOpts, handler) : http.createServer(handler);
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, '0.0.0.0', function () {
  console.log('巡检台账服务已启动: ' + (TLS_ON ? 'https' : 'http') + '://0.0.0.0:' + PORT +
    '  APP_DIR=' + APP_DIR + '  DB=' + DB_FILE + (TLS_ON ? '  TLS=on' : '  TLS=off（未找到证书）'));
});

/* 明文入口只做跳转，避免用户按 IP 直接访问时停在 http 上 */
let redirectServer = null;
if (REDIRECT_PORT) {
  const suffix = HTTPS_PORT === 443 ? '' : ':' + HTTPS_PORT;
  redirectServer = http.createServer(function (req, res) {
    const host = String(req.headers.host || '').split(':')[0] || 'localhost';
    res.writeHead(301, {
      location: 'https://' + host + suffix + (req.url || '/'),
      'cache-control': 'no-store',
      'content-length': 0
    });
    res.end();
  });
  redirectServer.listen(REDIRECT_PORT, '0.0.0.0', function () {
    console.log('HTTP 跳转已启用: http://0.0.0.0:' + REDIRECT_PORT + ' → https://…' + suffix);
  });
}

function shutdown(sig) {
  console.log('[shutdown] 收到 ' + sig + '，正在关闭…');
  try { if (redirectServer) redirectServer.close(); } catch (e) {}
  server.close(function () {
    try { db.close(); } catch (e) {}
    process.exit(0);
  });
  setTimeout(function () { process.exit(0); }, 8000).unref();
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('uncaughtException', function (e) { console.error('[fatal] ' + (e && e.stack ? e.stack : e)); });
