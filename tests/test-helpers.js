/* ============================================================
   test-helpers.js —— V2 多用户环境的共享测试脚手架
   在 JSDOM 解析前注入「账号注册表 + 登录会话 + 各账号台账」，
   使 boot() 能直接进入看板，从而复用既有的看板功能断言。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'inspection-dashboard.html');
const PROV_PATH = path.join(path.dirname(HTML_PATH), 'assets/provinces.js');

/* 省界数据已从页面拆到 assets/provinces.js，由 loadProvinces() 运行时异步注入。
   JSDOM 不下载外部脚本，所以在脚手架标记处把同一份文件内联进来：
   测试与线上走的是同一段安装逻辑（loadProvinces 的「已预置」分支），只是免去网络请求。 */
let html = fs.readFileSync(HTML_PATH, 'utf8');
const PROV_MARK = /<!-- __PROVINCES_INLINE__[^>]*-->/;
if (!PROV_MARK.test(html)) {
  throw new Error('页面缺少 __PROVINCES_INLINE__ 标记，无法内联 assets/provinces.js');
}
html = html.replace(PROV_MARK, function () {
  return '<script>\n' + fs.readFileSync(PROV_PATH, 'utf8') + '\n</script>';
});

const USERS_KEY   = 'inspection_board_users_v1';
const SESSION_KEY = 'inspection_board_session_v1';
const SCOPE_ALL   = '__all__';
const dataKey = u => 'inspection_board_v1::' + u;

/* 与页面内 hashPwd 等价的实现（已对照 Node crypto 验证 SHA-256 一致） */
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function hashPwd(pwd, salt) {
  let x = salt + '|' + pwd;
  for (let i = 0; i < 400; i++) x = sha(x + '#' + i + '|' + salt);
  return x;
}
function mkUser(o) {
  const salt = o.salt || ('salt-' + o.username);
  return {
    id: o.id || ('u-' + o.username),
    username: o.username,
    name: o.name,
    role: o.role || 'user',
    status: o.status || 'active',
    salt,
    pwd: hashPwd(o.password, salt),
    createdAt: '2026-01-01',
    lastLogin: '',
    note: o.note || ''
  };
}

/* 默认夹具：admin(超级管理员) + demo(普通用户，承担看板功能测试) */
function fixture() {
  return {
    version: 1,
    users: [
      mkUser({ username: 'admin', name: '超级管理员', role: 'admin', password: 'admin888' }),
      mkUser({ username: 'demo',  name: '演示用户',   role: 'user',  password: 'demo888' })
    ]
  };
}

/**
 * @param {object} [opts]
 *   opts.fixture    自定义账号注册表（默认 fixture()）
 *   opts.sessionUser 注入登录会话的用户名；传 null 表示未登录
 *   opts.data       { 用户名: {regions,customers,visits} } 预置台账
 *   opts.errors     运行时错误收集数组
 *   opts.virtualConsole 自定义虚拟控制台
 */
function makeDom(opts) {
  opts = opts || {};
  const users = opts.fixture || fixture();
  const errors = opts.errors || [];
  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:8899/inspection-dashboard.html',
    pretendToBeVisual: true,
    virtualConsole: opts.virtualConsole || new VirtualConsole().on('jsdomError', e => {
      if (/Not implemented/.test(e.message)) return;
      errors.push(e.message);
    }),
    beforeParse(window) {
      const ls = window.localStorage;
      ls.setItem(USERS_KEY, JSON.stringify(users));
      if (opts.sessionUser !== null) {
        ls.setItem(SESSION_KEY, JSON.stringify({
          username: opts.sessionUser || 'demo',
          at: '2026-01-01T00:00:00Z'
        }));
      }
      if (opts.data) {
        Object.keys(opts.data).forEach(u => ls.setItem(dataKey(u), JSON.stringify(opts.data[u])));
      }
      /* 关闭自动提醒弹窗，保证用例互不干扰、时序确定 */
      ['__all__', 'admin', 'demo', opts.sessionUser || 'demo'].forEach(s => {
        ls.setItem('inspection_board_pref_v1::' + s,
          JSON.stringify({ autoRemind: false, mutedQuarters: [] }));
      });
      /* 可选：注入全局桩（例如 TMap），用于覆盖「地图已就绪」的代码路径 */
      if (typeof opts.installGlobals === 'function') opts.installGlobals(window);
    }
  });
}

module.exports = {
  html, HTML_PATH, makeDom, mkUser, fixture, hashPwd, sha,
  dataKey, USERS_KEY, SESSION_KEY, SCOPE_ALL
};
