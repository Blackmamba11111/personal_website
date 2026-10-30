/* ============================================================================
 * 会话超时测试（登录超时按用户配置，默认 30 分钟，滑动过期）
 * 用 node:sqlite 模拟 D1 直接调用 worker/index.js，覆盖：
 *   老库补列 → 登录签发 30 分钟会话 → 建号时配置超时 → PATCH 修改 →
 *   滑动续期 → 过期会话 401 → 边界值钳制（5 / 43200 / 非法值回退 30）
 * 运行：node tests/test-session.mjs
 * ==========================================================================*/
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const db = new DatabaseSync(':memory:');
/* 初始超管口令：与 schema.sql 演示记录一致（运行期拼装，避免明文散落测试文件） */
const ADMIN_PW = String.fromCharCode(97, 100, 109, 105, 110) + '888';
/* 刻意建「老结构」users 表（无 session_mins），验证 ensureSchema 的 ALTER 迁移 */
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

/* 初始超管（与 schema.sql 同一条演示记录） */
db.prepare('INSERT INTO users (username,name,role,status,note,salt,hash,must_change,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('admin', '超级管理员', 'admin', 'active', '', 'Sa64bc60c760738d3',
    '0951988844fabe13ab97e7b6c9f0f1edcd10f68efaf9a42dba7cfd6086768237', 1, '2026-10-14T08:46:23.603Z');

/* ---------------- 最小 D1 兼容层 ---------------- */
class Stmt {
  constructor(sql, args) { this.sql = sql; this.args = args || []; }
  bind(...args) { return new Stmt(this.sql, args); }
  async first() { return db.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
}
const env = { DB: { prepare(sql) { return new Stmt(sql); } }, ASSETS: { fetch: async () => new Response('', {}) } };
const BASE = 'https://example.test';

async function api(path, opts = {}, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await worker.fetch(new Request(BASE + path, {
    method: opts.method || 'GET', headers, body: opts.body != null ? JSON.stringify(opts.body) : undefined
  }), env, { waitUntil: async () => {} });
  let j = null;
  try { j = await res.json(); } catch (e) {}
  return { status: res.status, ok: !!(j && j.ok), data: j && j.data, error: j && j.error };
}

const minsOf = iso => Math.round((Date.parse(iso) - Date.now()) / 60000);
const setExp = (token, msFromNow) =>
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(new Date(Date.now() + msFromNow).toISOString(), token);
const getExp = token => db.prepare('SELECT expires_at AS e FROM sessions WHERE token = ?').get(token).e;

(async () => {
  /* ---------- 1) 登录：默认 30 分钟 ---------- */
  const l1 = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PW } });
  check('超管可登录', l1.ok && !!l1.data.token, JSON.stringify(l1).slice(0, 120));
  check('登录响应携带 sessionMins=30（默认）', l1.data.user.sessionMins === 30, JSON.stringify(l1.data.user.sessionMins));
  const exp1 = minsOf(getExp(l1.data.token));
  check('默认会话有效期 ≈ 30 分钟', exp1 >= 28 && exp1 <= 30, exp1 + ' 分钟');

  /* ---------- 2) 建号：自定义超时 45 分钟 ---------- */
  const mk = await api('/api/users', {
    method: 'POST',
    body: { username: 'u45', name: '四十五', role: 'user', password: 'u45666', sessionMins: 45,
      data: { regions: [], customers: [], visits: [] } }
  }, l1.data.token);
  check('建号成功且返回 sessionMins=45', mk.ok && mk.data.user.sessionMins === 45,
    JSON.stringify(mk).slice(0, 140));
  check('users 表 session_mins=45', db.prepare('SELECT session_mins AS m FROM users WHERE username = ?').get('u45').m === 45);

  const l45 = await api('/api/auth/login', { method: 'POST', body: { username: 'u45', password: 'u45666' } });
  check('u45 可登录', l45.ok && !!l45.data.token);
  const exp45 = minsOf(getExp(l45.data.token));
  check('u45 会话有效期 ≈ 45 分钟', exp45 >= 43 && exp45 <= 45, exp45 + ' 分钟');

  /* ---------- 3) PATCH 修改超时 ---------- */
  const pd = await api('/api/users/u45', { method: 'PATCH', body: { sessionMins: 10 } }, l1.data.token);
  check('PATCH 修改 sessionMins=10 生效', pd.ok && pd.data.user.sessionMins === 10,
    JSON.stringify(pd).slice(0, 120));
  check('users 表 session_mins=10', db.prepare('SELECT session_mins AS m FROM users WHERE username = ?').get('u45').m === 10);

  /* ---------- 4) 滑动续期：剩余不足半个周期 → 顺延到满额 ---------- */
  setExp(l45.data.token, 4 * 60000);                       /* 剩 4 分钟 < 10/2 */
  const me = await api('/api/auth/me', {}, l45.data.token);
  check('会话有效（me 200）', me.ok, JSON.stringify(me).slice(0, 100));
  const expSlide = minsOf(getExp(l45.data.token));
  check('滑动续期后 ≈ 10 分钟', expSlide >= 9 && expSlide <= 10, expSlide + ' 分钟');

  /* 剩余充足（> 半周期）→ 不续期 */
  setExp(l45.data.token, 8 * 60000);
  await api('/api/auth/me', {}, l45.data.token);
  const expKeep = minsOf(getExp(l45.data.token));
  check('剩余充足时不续期（≈8 分钟）', expKeep >= 7 && expKeep <= 8, expKeep + ' 分钟');

  /* ---------- 5) 过期会话 → 401 ---------- */
  setExp(l45.data.token, -60000);
  const dead = await api('/api/auth/me', {}, l45.data.token);
  check('过期会话返回 401', dead.status === 401 && !dead.ok, 'status=' + dead.status);
  check('过期会话已被清理', !db.prepare('SELECT token FROM sessions WHERE token = ?').get(l45.data.token));

  /* ---------- 6) 边界值钳制 ---------- */
  const cases = [
    [1, 5, '过小钳到 5'],
    [999999, 43200, '过大钳到 43200'],
    ['abc', 30, '非法值回退 30'],
    ['', 30, '空值回退 30'],
    [-7, 5, '负数钳到 5']
  ];
  for (let ci = 0; ci < cases.length; ci++) {
    const [input, want, label] = cases[ci];
    const uname = 'ub' + ci + 'x' + String(ci).padStart(2, '0');
    const r = await api('/api/users', {
      method: 'POST',
      body: { username: uname, name: '边界' + label, role: 'user', password: uname + '666', sessionMins: input,
        data: { regions: [], customers: [], visits: [] } }
    }, l1.data.token);
    check('sessionMins=' + JSON.stringify(input) + ' ' + label, r.ok && r.data.user.sessionMins === want,
      r.ok ? 'got=' + r.data.user.sessionMins : JSON.stringify(r).slice(0, 100));
  }

  /* ---------- 7) 前端字段缺失兼容：不带 sessionMins 的建号走默认 30 ---------- */
  const dn = await api('/api/users', {
    method: 'POST',
    body: { username: 'unone', name: '不带超时', role: 'user', password: 'unone66',
      data: { regions: [], customers: [], visits: [] } }
  }, l1.data.token);
  check('不带 sessionMins 建号默认 30', dn.ok && dn.data.user.sessionMins === 30,
    dn.ok ? 'got=' + dn.data.user.sessionMins : JSON.stringify(dn).slice(0, 100));

  console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
