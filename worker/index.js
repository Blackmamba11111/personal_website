/* ============================================================================
 * 客户巡检台账 · 服务端
 * 部署形态：Cloudflare Workers 静态资源 + D1（SQLite）
 * 路由约定：/api/* 由本脚本处理；其余请求交给静态资源（env.ASSETS）
 * 鉴权：Bearer Token（存 sessions 表，30 天有效）
 * ==========================================================================*/

const SESSION_DAYS = 30;
const HASH_ROUNDS = 400;

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
function normName(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function validUsername(u) { return /^[A-Za-z0-9_.-]{3,32}$/.test(u); }

/* ---------------- 会话 ---------------- */
async function currentUser(env, request) {
  const raw = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const token = m[1].trim();
  const row = await env.DB.prepare(
    'SELECT s.expires_at AS exp, u.username, u.name, u.role, u.status, u.note, u.must_change, u.created_at, u.last_login ' +
    'FROM sessions s JOIN users u ON u.username = s.username WHERE s.token = ?'
  ).bind(token).first();
  if (!row) return null;
  if (Date.parse(row.exp) < Date.now()) {
    try { await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run(); } catch (e) {}
    return null;
  }
  if (row.status !== 'active') return null;
  const u = mapUser(row);
  u.token = token;
  return u;
}

/* ---------------- 数据读写 ---------------- */
async function readLedger(env, username) {
  const row = await env.DB.prepare('SELECT data FROM ledgers WHERE username = ?').bind(username).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (e) { return null; }
}
async function writeLedger(env, username, data, by) {
  await env.DB.prepare(
    'INSERT INTO ledgers (username, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(username) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
  ).bind(username, JSON.stringify(data), nowIso(), by).run();
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
  let users;
  if (isAdmin) {
    const r = await env.DB.prepare(
      'SELECT username, name, role, status, note, must_change, created_at, last_login FROM users ORDER BY created_at'
    ).all();
    users = (r.results || []).map(mapUser);
  } else {
    users = [mapUser(u)];
  }
  const ledgers = {};
  if (isAdmin) {
    const r = await env.DB.prepare('SELECT username, data FROM ledgers').all();
    (r.results || []).forEach(function (row) {
      try { ledgers[row.username] = JSON.parse(row.data); } catch (e) {}
    });
  } else {
    const d = await readLedger(env, u.username);
    if (d) ledgers[u.username] = d;
  }
  return { user: mapUser(u), users: users, ledgers: ledgers, admin: isAdmin, attachMax: ATTACH_MAX };
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

/* ---------------- 路由 ---------------- */
async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try { body = await request.json(); } catch (e) { body = {}; }
  }

  /* --- 登录 --- */
  if (p === '/api/auth/login' && method === 'POST') {
    const username = normName(body.username);
    const password = String(body.password || '');
    if (!username || !password) return bad('请输入用户名与密码。');
    const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    /* 账号不存在与密码错误统一提示，避免账号枚举 */
    if (!u) return bad('用户名或密码不正确。', 401);
    const h = await hashPwd(password, u.salt);
    if (h !== u.hash) return bad('用户名或密码不正确。', 401);
    if (u.status !== 'active') return bad('该账号已停用，请联系超级管理员。', 403);

    const token = newToken();
    const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
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

  /* --- 用户管理（仅超管） --- */
  if (p === '/api/users' && method === 'GET') {
    if (!isAdmin) return bad('仅超级管理员可查看用户列表', 403);
    const r = await env.DB.prepare(
      'SELECT username, name, role, status, note, must_change, created_at, last_login FROM users ORDER BY created_at'
    ).all();
    return ok({ users: (r.results || []).map(mapUser) });
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

    /* 迁移路径：带 salt+hash 表示沿用原口令（本地旧版迁入），不需要重新设密码 */
    const legacySalt = String(body.salt || '');
    const legacyHash = String(body.hash || '');
    const isLegacy = /^[A-Za-z0-9]{4,64}$/.test(legacySalt) && /^[0-9a-f]{64}$/.test(legacyHash);

    let salt, hash, mustChange;
    if (isLegacy) {
      salt = legacySalt; hash = legacyHash; mustChange = 0;
    } else {
      const pwd = String(body.password || '');
      if (pwd.length < 6) return bad('密码至少 6 位');
      salt = newSalt();
      hash = await hashPwd(pwd, salt);
      mustChange = 1;
    }
    await env.DB.prepare(
      'INSERT INTO users (username, name, role, status, note, salt, hash, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(username, name, role, 'active', String(body.note || ''), salt, hash, mustChange, nowIso()).run();
    /* 初始化台账：由调用方决定是否复制示例数据 */
    if (body.data) await writeLedger(env, username, sanitizeLedger(body.data), me.username);
    return ok({ user: mapUser(await env.DB.prepare(
      'SELECT username, name, role, status, note, must_change, created_at, last_login FROM users WHERE username = ?'
    ).bind(username).first()) });
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
      const losingAdmin = row.role === 'admin' && row.status === 'active' && (role !== 'admin' || status !== 'active');
      if (losingAdmin && await activeAdminCount(env, target) === 0) {
        return bad('至少需要保留一个启用的超级管理员');
      }
      await env.DB.prepare('UPDATE users SET name = ?, role = ?, status = ?, note = ? WHERE username = ?')
        .bind(name, role, status, note, target).run();
      if (body.password != null && String(body.password).length) {
        const np = String(body.password);
        if (np.length < 6) return bad('密码至少 6 位');
        const salt = newSalt();
        await env.DB.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 1 WHERE username = ?')
          .bind(salt, await hashPwd(np, salt), target).run();
        await env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(target).run();
      }
      const fresh = await env.DB.prepare(
        'SELECT username, name, role, status, note, must_change, created_at, last_login FROM users WHERE username = ?'
      ).bind(target).first();
      return ok({ user: mapUser(fresh) });
    }

    if (method === 'DELETE') {
      if (target === me.username) return bad('不能删除当前登录账号');
      if (row.role === 'admin' && row.status === 'active' && await activeAdminCount(env, target) === 0) {
        return bad('至少保留一个启用的超级管理员，无法删除');
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(target),
        env.DB.prepare('DELETE FROM ledgers WHERE username = ?').bind(target),
        env.DB.prepare('DELETE FROM users WHERE username = ?').bind(target)
      ]);
      /* 附件表可能尚未创建（从未上传过附件），失败不影响删号 */
      try { await env.DB.prepare('DELETE FROM attachments WHERE owner = ?').bind(target).run(); } catch (e) {}
      return ok(null);
    }
    return bad('不支持的请求方法', 405);
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
