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
 *   PORT      监听端口，默认 18080
 *   APP_DIR   静态资源根目录，默认 /app
 *   DATA_DIR  数据目录（挂载卷），默认 /data
 * ==========================================================================*/

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '18080', 10);
const APP_DIR = path.resolve(process.env.APP_DIR || '/app');
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const SESSION_DAYS = 30;
const HASH_ROUNDS = 400;
const MAX_BODY = 32 * 1024 * 1024; // 台账 JSON 可能较大

/* ---------------- 数据库 ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
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
  last_login  TEXT NOT NULL DEFAULT ''
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
`);

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

function mapUser(row) {
  return {
    id: row.username,
    username: row.username,
    name: row.name,
    role: row.role,
    status: row.status,
    note: row.note || '',
    mustChange: !!row.must_change,
    createdAt: (row.created_at || '').slice(0, 10),
    lastLogin: row.last_login || ''
  };
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
  'SELECT s.expires_at AS exp, u.username, u.name, u.role, u.status, u.note, u.must_change, u.created_at, u.last_login ' +
  'FROM sessions s JOIN users u ON u.username = s.username WHERE s.token = ?';
const USER_COLS = 'username, name, role, status, note, must_change, created_at, last_login';

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
  const u = mapUser(row);
  u.token = token;
  return u;
}

function readLedger(username) {
  const row = db.prepare('SELECT data FROM ledgers WHERE username = ?').get(username);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (e) { return null; }
}
function writeLedger(username, data, by) {
  db.prepare(
    'INSERT INTO ledgers (username, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
  ).run(username, JSON.stringify(data), nowIso(), by);
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
  let users;
  if (isAdmin) {
    users = db.prepare('SELECT ' + USER_COLS + ' FROM users ORDER BY created_at').all().map(mapUser);
  } else {
    users = [mapUser(u)];
  }
  const ledgers = {};
  if (isAdmin) {
    db.prepare('SELECT username, data FROM ledgers').all().forEach(function (row) {
      try { ledgers[row.username] = JSON.parse(row.data); } catch (e) {}
    });
  } else {
    const d = readLedger(u.username);
    if (d) ledgers[u.username] = d;
  }
  return { user: mapUser(u), users: users, ledgers: ledgers, admin: isAdmin };
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
    if (hashPwd(password, u.salt) !== u.hash) return bad(res, '用户名或密码不正确。', 401);
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

  /* --- 台账读写：scope = 用户名；超管可读写任何人 --- */
  if (p === '/api/ledger' && method === 'GET') return ok(res, bundleFor(me));

  if (p === '/api/ledger' && method === 'PUT') {
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

  /* --- 用户管理（仅超管） --- */
  if (p === '/api/users' && method === 'GET') {
    if (!isAdmin) return bad(res, '仅超级管理员可查看用户列表', 403);
    const users = db.prepare('SELECT ' + USER_COLS + ' FROM users ORDER BY created_at').all().map(mapUser);
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

    /* 迁移路径：带 salt+hash 表示沿用原口令，不需要重新设密码 */
    const legacySalt = String(body.salt || '');
    const legacyHash = String(body.hash || '');
    const isLegacy = /^[A-Za-z0-9]{4,64}$/.test(legacySalt) && /^[0-9a-f]{64}$/.test(legacyHash);

    let salt, hash, mustChange;
    if (isLegacy) {
      salt = legacySalt; hash = legacyHash; mustChange = 0;
    } else {
      const pwd = String(body.password || '');
      if (pwd.length < 6) return bad(res, '密码至少 6 位');
      salt = newSalt();
      hash = hashPwd(pwd, salt);
      mustChange = 1;
    }
    db.prepare(
      'INSERT INTO users (username, name, role, status, note, salt, hash, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(username, name, role, 'active', String(body.note || ''), salt, hash, mustChange, nowIso());
    if (body.data) writeLedger(username, sanitizeLedger(body.data), me.username);
    return ok(res, {
      user: mapUser(db.prepare('SELECT ' + USER_COLS + ' FROM users WHERE username = ?').get(username))
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
      const losingAdmin = row.role === 'admin' && row.status === 'active' && (role !== 'admin' || status !== 'active');
      if (losingAdmin && activeAdminCount(target) === 0) {
        return bad(res, '至少需要保留一个启用的超级管理员');
      }
      db.prepare('UPDATE users SET name = ?, role = ?, status = ?, note = ? WHERE username = ?')
        .run(name, role, status, note, target);
      if (body.password != null && String(body.password).length) {
        const np = String(body.password);
        if (np.length < 6) return bad(res, '密码至少 6 位');
        const salt = newSalt();
        db.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 1 WHERE username = ?')
          .run(salt, hashPwd(np, salt), target);
        db.prepare('DELETE FROM sessions WHERE username = ?').run(target);
      }
      return ok(res, {
        user: mapUser(db.prepare('SELECT ' + USER_COLS + ' FROM users WHERE username = ?').get(target))
      });
    }

    if (method === 'DELETE') {
      if (target === me.username) return bad(res, '不能删除当前登录账号');
      if (row.role === 'admin' && row.status === 'active' && activeAdminCount(target) === 0) {
        return bad(res, '至少保留一个启用的超级管理员，无法删除');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM sessions WHERE username = ?').run(target);
        db.prepare('DELETE FROM ledgers WHERE username = ?').run(target);
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

  return bad(res, '接口不存在', 404);
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
const BLOCKED = /^\/(server\.js|package(-lock)?\.json|Dockerfile|docker-compose\.yml|\.dockerignore|data\/|node_modules\/|\.git\/|tests\/|worker\/)/;

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
  const cc = ext === '.html'
    ? 'no-cache'
    : (rel.indexOf('/assets/') === 0 ? 'public, max-age=600' : 'public, max-age=3600');

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
const server = http.createServer(function (req, res) {
  const started = Date.now();
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  res.on('finish', function () {
    const line = req.method + ' ' + url.pathname + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms';
    if (res.statusCode >= 400) console.log('[warn] ' + line); else console.log(line);
  });

  if (url.pathname === '/healthz') {
    return sendJson(res, { ok: true, db: DB_FILE, uptime: Math.round(process.uptime()) });
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
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, '0.0.0.0', function () {
  console.log('巡检台账服务已启动: http://0.0.0.0:' + PORT + '  APP_DIR=' + APP_DIR + '  DB=' + DB_FILE);
});

function shutdown(sig) {
  console.log('[shutdown] 收到 ' + sig + '，正在关闭…');
  server.close(function () {
    try { db.close(); } catch (e) {}
    process.exit(0);
  });
  setTimeout(function () { process.exit(0); }, 8000).unref();
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('uncaughtException', function (e) { console.error('[fatal] ' + (e && e.stack ? e.stack : e)); });
