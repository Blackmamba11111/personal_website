/* ============================================================================
 * 测试脚手架（服务端版）
 * 台账改造后，前端改为向 /api/* 取数与写数。jsdom 里没有 fetch，
 * 因此这里在 makeDom 的 beforeParse 阶段注入一个「内存版服务端」，
 * 行为与 worker/index.js 对齐（同一套 hashPwd、同一套权限判定）。
 *
 * 用法：把测试文件里的 require('./test-helpers') 换成 require('./test-helpers-server')。
 * ==========================================================================*/

const H = require('./test-helpers');

const TOKEN_KEY = 'inspection_board_token_v1';
const DATA_PREFIX = 'inspection_board_v1::';

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
function ok(d) { return jsonRes({ ok: true, data: d === undefined ? null : d }); }
function bad(msg, st) { return jsonRes({ ok: false, error: msg }, st || 400); }

function userView(u) {
  return {
    id: u.id || u.username,
    username: u.username,
    name: u.name,
    role: u.role || 'user',
    status: u.status || 'active',
    note: u.note || '',
    mustChange: !!u.mustChange,
    createdAt: u.createdAt || '',
    lastLogin: u.lastLogin || '',
    source: u.source || 'local',
    perm: u.perm === 'ro' ? 'ro' : 'rw',
    serverId: u.serverId || '',
    serverName: u.serverName || '',
    serverType: u.serverType || '',
    shareFrom: u.shareFrom || ''
  };
}

function installApiStub(window, opts) {
  opts = opts || {};
  const ls = window.localStorage;

  let reg = null;
  try { reg = JSON.parse(ls.getItem(H.USERS_KEY)); } catch (e) {}
  const srv = {
    users: (reg && reg.users) ? reg.users.slice() : [],
    ledgers: {},
    logs: [],                 /* 台账变更日志：{username(owner), actor, kind, action, target, detail, at} */
    attachments: {},          /* id -> {id,name,mime,size,data(base64),owner} */
    servers: (opts.servers || []).slice()   /* 认证服务器（远程用户用） */
  };
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && k.indexOf(DATA_PREFIX) === 0) {
      try { srv.ledgers[k.slice(DATA_PREFIX.length)] = JSON.parse(ls.getItem(k)); } catch (e) {}
    }
  }
  /* 暴露给用例：可直接断言「服务端」侧的数据 */
  window.__SRV__ = srv;

  const TOKEN = 'test-token';
  let me = (opts.sessionUser === null) ? null : (opts.sessionUser || 'demo');
  /* 旧的「会话」键已废弃（会话改由服务端签发的 Token 承载），清掉以免旧用例断言被残留值干扰 */
  try { ls.removeItem(H.SESSION_KEY); } catch (e) {}
  /* 2026-10-26 起令牌只存 sessionStorage（不再「记住登录」） */
  if (me) {
    window.sessionStorage.setItem(TOKEN_KEY, TOKEN);
    ls.removeItem(TOKEN_KEY);
  }

  const findUser = (name) => {
    const n = String(name == null ? '' : name).trim().toLowerCase();
    return srv.users.filter(x => String(x.username).toLowerCase() === n)[0];
  };
  const writeMirror = () => {
    ls.setItem(H.USERS_KEY, JSON.stringify({ version: 2, users: srv.users }));
  };
  const currentUser = () => {
    if (!me) return null;
    let tk = '';
    try { tk = ls.getItem(TOKEN_KEY) || window.sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
    if (tk !== TOKEN) return null;
    const u = findUser(me);
    if (!u || (u.status || 'active') !== 'active') return null;
    return u;
  };
  const viewOf = (u) => {
    const v = userView(u);
    const s = srv.servers.filter(x => x.id === (u.serverId || ''))[0];
    if (s) { v.serverName = s.name; v.serverType = s.type; }
    v.sharedWith = srv.users.filter(x => (x.shareFrom || '') === u.username).map(x => x.username);
    return v;
  };
  /* 共享数据集：成员的读写都落在数据归属者名下 */
  const dataOwner = (username) => {
    const u = findUser(username);
    return (u && u.shareFrom) ? u.shareFrom : username;
  };
  const bundle = (u) => {
    const isAdmin = u.role === 'admin';
    const ledgers = {};
    if (isAdmin) {
      srv.users.forEach(x => {
        const owner = dataOwner(x.username);
        if (srv.ledgers[owner]) ledgers[x.username] = srv.ledgers[owner];
      });
    } else if (srv.ledgers[dataOwner(u.username)]) {
      ledgers[u.username] = srv.ledgers[dataOwner(u.username)];
    }
    const view = viewOf(u);
    return {
      user: view,
      users: isAdmin ? srv.users.map(viewOf) : [view],
      ledgers: ledgers,
      admin: isAdmin,
      canWrite: isAdmin || (u.perm !== 'ro'),
      token: TOKEN,
      attachMax: 20 * 1024 * 1024,
      authServers: isAdmin ? srv.servers.map(serverView) : []
    };
  };

  /* 认证服务器脱敏视图：密钥只给 hasSecret 标记 */
  function serverView(s) {
    const cfg = s.cfg || {};
    return {
      id: s.id, name: s.name, type: s.type, host: s.host, port: s.port,
      enabled: s.enabled !== false,
      createdAt: '2026-01-01', updatedAt: '',
      userCount: srv.users.filter(u => u.serverId === s.id).length,
      hasSecret: !!cfg.secret,
      cfg: {
        timeout: cfg.timeout || 5, nasId: cfg.nasId || '', plain: cfg.plain || 0,
        bindPattern: cfg.bindPattern || '', baseDn: cfg.baseDn || '', userAttr: cfg.userAttr || '',
        tls: cfg.tls || 0, verifyTls: cfg.verifyTls || 0
      }
    };
  }
  /* 桩里的「远程认证」：只要口令等于 remote-ok 就算通过，否则拒绝。
     桩不跑真实网络协议（那部分见 tests/test-protocols.mjs 与 test-worker-api.mjs）。 */
  const REMOTE_PASSWORD = opts.remotePassword || 'remote-ok';

  /* 台账 diff 日志（与两版真实服务端同口径，供用例断言 actor / 明细） */
  const FL = { name: '客户名称', regionId: '所属区域', province: '省份', city: '城市', addr: '地址',
    lng: '经度', lat: '纬度', freq: '巡检频率', contact: '联系人', phone: '联系电话', note: '备注',
    by: '巡检人', date: '巡检日期', mode: '巡检方式', result: '巡检结果' };
  const fmtV = (v) => (v === undefined || v === null || v === '') ? '空' : String(v);
  const byIdM = (arr) => { const m = {}; (arr || []).forEach(x => { if (x && x.id) m[x.id] = x; }); return m; };
  function diffLogs(oldD, newD) {
    const out = [];
    oldD = oldD || { regions: [], customers: [], visits: [] };
    const cname = (d, id) => { const c = (d.customers || []).filter(x => x.id === id)[0]; return c ? c.name : id; };
    const oc = byIdM(oldD.customers), nc = byIdM(newD.customers);
    Object.keys(nc).forEach(id => {
      if (!oc[id]) { out.push({ kind: 'customer', action: 'add', target: nc[id].name || id, detail: '' }); return; }
      const df = [];
      Object.keys(nc[id]).forEach(k => {
        if (JSON.stringify(oc[id][k]) !== JSON.stringify(nc[id][k])) df.push((FL[k] || k) + '：' + fmtV(oc[id][k]) + ' → ' + fmtV(nc[id][k]));
      });
      if (df.length) out.push({ kind: 'customer', action: 'update', target: nc[id].name || id, detail: df.join('；') });
    });
    Object.keys(oc).forEach(id => { if (!nc[id]) out.push({ kind: 'customer', action: 'delete', target: oc[id].name || id, detail: '' }); });
    const ov = byIdM(oldD.visits), nv = byIdM(newD.visits);
    Object.keys(nv).forEach(id => {
      const v = nv[id], label = cname(newD, v.customerId) + ' · ' + (v.date || '');
      if (!ov[id]) { out.push({ kind: 'visit', action: 'add', target: label, detail: v.by ? '巡检人 ' + v.by : '' }); return; }
      const df = [];
      Object.keys(v).forEach(k => {
        if (JSON.stringify(ov[id][k]) !== JSON.stringify(v[k])) df.push((FL[k] || k) + '：' + fmtV(ov[id][k]) + ' → ' + fmtV(v[k]));
      });
      if (df.length) out.push({ kind: 'visit', action: 'update', target: label, detail: df.join('；') });
    });
    Object.keys(ov).forEach(id => {
      if (!nv[id]) out.push({ kind: 'visit', action: 'delete', target: cname(oldD, ov[id].customerId) + ' · ' + (ov[id].date || ''), detail: '' });
    });
    const org = byIdM(oldD.regions), nrg = byIdM(newD.regions);
    Object.keys(nrg).forEach(id => {
      if (!org[id]) out.push({ kind: 'region', action: 'add', target: nrg[id].name || id, detail: '' });
    });
    Object.keys(org).forEach(id => { if (!nrg[id]) out.push({ kind: 'region', action: 'delete', target: org[id].name || id, detail: '' }); });
    return out;
  }
  const pushLogs = (owner, actor, oldData, newData) => {
    const list = oldData ? diffLogs(oldData, newData) : [{ kind: 'init', action: 'add', target: '台账', detail: '初始化台账' }];
    if (!list.length) return;
    const at = new Date().toISOString();
    list.forEach(l => srv.logs.push({
      username: owner, actor: actor, kind: l.kind, action: l.action, target: l.target || '', detail: l.detail || '', at: at
    }));
  };

  function route(p, method, body) {
    if (p === '/auth/login' && method === 'POST') {      const u = findUser(body.username);
      if (!u) return bad('用户名或密码不正确。', 401);
      const src = u.source || 'local';
      if (src === 'local') {
        if (H.hashPwd(String(body.password || ''), u.salt) !== u.pwd) return bad('用户名或密码不正确。', 401);
      } else {
        const s = srv.servers.filter(x => x.id === (u.serverId || ''))[0];
        if (!s || s.enabled === false) return bad('认证服务暂时不可用，请联系超级管理员。', 503);
        if (String(body.password || '') !== REMOTE_PASSWORD) return bad('用户名或密码不正确。', 401);
      }
      if ((u.status || 'active') !== 'active') return bad('该账号已停用，请联系超级管理员。', 403);
      me = u.username;
      window.sessionStorage.setItem(TOKEN_KEY, TOKEN);
      return ok(bundle(u));
    }

    /* 附件读取：公开（<img>/<iframe> 带不了 Authorization），id 不可猜 */
    const ma = /^\/attach\/([A-Za-z0-9]+)$/.exec(p);
    if (ma && (method === 'GET' || method === 'HEAD')) {
      const rec = srv.attachments[ma[1]];
      if (!rec) return jsonRes({ ok: false, error: '附件已删除' }, 404);
      return new Response(Buffer.from(rec.data, 'base64'), {
        status: 200,
        headers: { 'content-type': rec.mime }
      });
    }

    const auth = currentUser();
    if (!auth) return bad('登录已失效，请重新登录。', 401);

    if (p === '/attach' && method === 'POST') {
      if (auth.role !== 'admin' && auth.perm === 'ro') return bad('当前账号为只读权限，不能上传附件。', 403);
      const data = String(body.data || '');
      if (!data) return bad('附件内容为空');
      const size = Buffer.from(data, 'base64').length;
      const id = 'att' + (Object.keys(srv.attachments).length + 1) + Date.now().toString(36);
      srv.attachments[id] = {
        id: id, name: String(body.name || 'file'), mime: String(body.mime || 'application/octet-stream'),
        size: size, data: data, owner: auth.username
      };
      return ok({ id: id, name: srv.attachments[id].name, mime: srv.attachments[id].mime, size: size, url: '/api/attach/' + id });
    }
    const md = /^\/attach\/([A-Za-z0-9]+)$/.exec(p);
    if (md && method === 'DELETE') {
      if (!srv.attachments[md[1]]) return ok({ removed: false });
      delete srv.attachments[md[1]];
      return ok({ removed: true });
    }

    if (p === '/auth/me' && method === 'GET') return ok(bundle(auth));
    if (p === '/auth/logout') { ls.removeItem(TOKEN_KEY); window.sessionStorage.removeItem(TOKEN_KEY); me = null; return ok(null); }

    if (p === '/auth/password' && method === 'POST') {
      if ((auth.source || 'local') !== 'local') return bad('该账号使用远程认证，密码请到对应的认证系统修改。', 400);
      if (H.hashPwd(String(body.oldPassword || ''), auth.salt) !== auth.pwd) return bad('当前密码不正确');
      auth.salt = 'salt-' + auth.username + '-new';
      auth.pwd = H.hashPwd(String(body.newPassword || ''), auth.salt);
      auth.mustChange = false;
      writeMirror();
      return ok(null);
    }

    if (p === '/ledger' && method === 'GET') return ok(bundle(auth));
    if (p === '/ledger' && method === 'PUT') {
      if (auth.role !== 'admin' && auth.perm === 'ro') return bad('当前账号为只读权限，不能修改台账。', 403);
      const scope = String(body.scope || '').toLowerCase();
      if (auth.role !== 'admin' && scope !== auth.username) return bad('无权写入该账号的台账', 403);
      const owner = dataOwner(scope);
      const oldData = srv.ledgers[owner] || null;
      srv.ledgers[owner] = body.data || { regions: [], customers: [], visits: [] };
      pushLogs(owner, auth.username, oldData, srv.ledgers[owner]);
      ls.setItem(DATA_PREFIX + owner, JSON.stringify(srv.ledgers[owner]));
      return ok({ scope: scope });
    }

    /* 数据变更日志：按数据归属查询（共享数据集共用一份历史） */
    if (p.split('?')[0] === '/logs' && method === 'GET') {
      const qp = new URLSearchParams(p.split('?')[1] || '');
      const req = String(qp.get('username') || auth.username).toLowerCase();
      if (!findUser(req)) return bad('用户不存在', 404);
      /* 共享数据集按归属解析：成员查看归属者的日志与查看本人日志等价（与 Worker 版一致） */
      if (auth.role !== 'admin' && dataOwner(req) !== dataOwner(auth.username)) return bad('无权查看该账号的数据日志', 403);
      const owner = dataOwner(req);
      return ok({ owner: owner, logs: srv.logs.filter(l => l.username === owner).slice(-300).reverse() });
    }

    /* --- 认证服务器（远程用户） --- */
    if (p === '/auth-servers' && method === 'GET') {
      if (auth.role !== 'admin') return bad('仅超级管理员可查看认证服务器', 403);
      return ok({ servers: srv.servers.map(serverView) });
    }
    if (p === '/auth-servers' && method === 'POST') {
      if (auth.role !== 'admin') return bad('仅超级管理员可新增认证服务器', 403);
      if (!body.name) return bad('请填写认证服务器名称');
      if (!body.host) return bad('请填写服务器地址');
      const type = ['radius', 'tacacs', 'ldap'].indexOf(body.type) >= 0 ? body.type : '';
      if (!type) return bad('认证类型需为 RADIUS / TACACS+ / LDAP 之一');
      const cfg = body.cfg || {};
      if (type !== 'ldap' && !cfg.secret) return bad('RADIUS / TACACS+ 需要填写共享密钥（secret）');
      const id = 'srv' + (srv.servers.length + 1);
      srv.servers.push({
        id: id, name: body.name, type: type, host: body.host,
        port: body.port || (type === 'radius' ? 1812 : (type === 'tacacs' ? 49 : 389)),
        enabled: body.enabled === 0 ? false : true, cfg: cfg
      });
      return ok({ server: serverView(srv.servers[srv.servers.length - 1]) });
    }
    if (p === '/auth-servers/test' && method === 'POST') {
      if (auth.role !== 'admin') return bad('仅超级管理员可测试认证服务器', 403);
      if (!body.username || !body.password) return bad('请填写用于测试的账号与密码');
      const okAuth = String(body.password) === REMOTE_PASSWORD;
      return ok({ ok: okAuth, code: okAuth ? 'accept' : 'reject', message: okAuth ? '认证通过' : '认证被拒绝（用户名或密码不正确）' });
    }
    const msv = /^\/auth-servers\/([A-Za-z0-9_-]{4,40})$/.exec(p);
    if (msv) {
      if (auth.role !== 'admin') return bad('仅超级管理员可修改认证服务器', 403);
      const s = srv.servers.filter(x => x.id === msv[1])[0];
      if (!s) return bad('认证服务器不存在', 404);
      if (method === 'PATCH') {
        ['name', 'type', 'host', 'port', 'enabled'].forEach(k => { if (body[k] != null) s[k] = body[k]; });
        if (body.cfg) {
          const cfg = Object.assign({}, s.cfg);
          Object.keys(body.cfg).forEach(k => { cfg[k] = body.cfg[k]; });
          s.cfg = cfg;
        }
        return ok({ server: serverView(s) });
      }
      if (method === 'DELETE') {
        const n = srv.users.filter(u => u.serverId === s.id).length;
        if (n > 0) return bad('仍有 ' + n + ' 个账号使用该认证服务器，请先改绑或删除这些账号');
        srv.servers = srv.servers.filter(x => x.id !== s.id);
        return ok(null);
      }
    }

    if (p === '/users' && method === 'GET') {
      if (auth.role !== 'admin') return bad('仅超级管理员可查看用户列表', 403);
      return ok({ users: srv.users.map(viewOf) });
    }
    if (p === '/users' && method === 'POST') {
      if (auth.role !== 'admin') return bad('仅超级管理员可创建用户', 403);
      const un = String(body.username || '').toLowerCase();
      if (findUser(un)) return bad('用户名「' + un + '」已存在');
      const serverId = String(body.serverId || '');
      const s = serverId ? srv.servers.filter(x => x.id === serverId)[0] : null;
      if (serverId && !s) return bad('所选认证服务器不存在');
      const salt = 'salt-' + un;
      /* 共享数据集：shareFrom 解析到数据归属者（避免链式），不复制数据 */
      let shareFrom = '';
      if (body.shareFrom) {
        const src = findUser(body.shareFrom);
        if (!src) return bad('要共享数据的来源用户不存在');
        shareFrom = src.shareFrom || src.username;
        if ((body.role === 'admin') && shareFrom !== un) return bad('超级管理员维护全局数据，不参与共享数据集');
      }
      const nu = {
        id: un, username: un, name: body.name,
        role: body.role === 'admin' ? 'admin' : 'user',
        status: 'active', note: body.note || '',
        source: s ? s.type : 'local',
        perm: body.role === 'admin' ? 'rw' : (body.perm === 'ro' ? 'ro' : 'rw'),
        serverId: serverId,
        shareFrom: shareFrom,
        salt: salt,
        pwd: s ? '' : H.hashPwd(String(body.password || ''), salt),
        mustChange: !s, createdAt: '2026-01-01', lastLogin: ''
      };
      srv.users.push(nu);
      if (!shareFrom && body.data) srv.ledgers[un] = body.data;
      writeMirror();
      return ok({ user: viewOf(nu) });
    }

    const m = /^\/users\/([^/]+)$/.exec(p);
    if (m) {
      if (auth.role !== 'admin') return bad('仅超级管理员可修改用户', 403);
      const t = findUser(decodeURIComponent(m[1]));
      if (!t) return bad('用户不存在', 404);
      if (method === 'PATCH') {
        if (body.name != null) t.name = body.name;
        if (body.role != null) t.role = body.role === 'admin' ? 'admin' : 'user';
        if (body.status != null) t.status = body.status === 'disabled' ? 'disabled' : 'active';
        if (body.note != null) t.note = body.note;
        if (body.perm != null) t.perm = body.perm === 'ro' ? 'ro' : 'rw';
        if (body.serverId !== undefined) {
          const sid = String(body.serverId || '');
          const s = sid ? srv.servers.filter(x => x.id === sid)[0] : null;
          if (sid && !s) return bad('所选认证服务器不存在');
          t.serverId = sid;
          t.source = s ? s.type : 'local';
          if (!s) t.pwd = '';
        }
        if (body.password) {
          if ((t.source || 'local') !== 'local') return bad('远程账号不能在本地重置密码');
          t.salt = 'salt-' + t.username + '-r';
          t.pwd = H.hashPwd(String(body.password), t.salt);
          t.mustChange = true;
        }
        writeMirror();
        return ok({ user: viewOf(t) });
      }
      if (method === 'DELETE') {
        if (t.username === auth.username) return bad('不能删除当前登录账号');
        /* 共享数据集：删 owner 且有成员 → 台账转给最早成员；删成员 → 数据不动 */
        if (!(t.shareFrom || '').length) {
          const members = srv.users.filter(x => (x.shareFrom || '') === t.username);
          if (members.length) {
            const heir = members[0].username;
            if (srv.ledgers[t.username]) srv.ledgers[heir] = srv.ledgers[t.username];
            srv.logs.forEach(l => { if (l.username === t.username) l.username = heir; });
            members.forEach(x => { x.shareFrom = (x.username === heir) ? '' : heir; });
          }
        }
        srv.users = srv.users.filter(x => x.username !== t.username);
        if (!(t.shareFrom || '').length) {
          const stillMembers = srv.users.filter(x => (x.shareFrom || '') === t.username);
          if (!stillMembers.length) delete srv.ledgers[t.username];
        }
        try { ls.removeItem(DATA_PREFIX + t.username); } catch (e) {}
        writeMirror();
        return ok(null);
      }
    }
    return bad('接口不存在', 404);
  }

  window.fetch = function (url, init) {
    init = init || {};
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch (e) { body = {}; }
    return Promise.resolve().then(() => route(path, method, body));
  };
}

function makeDom(opts) {
  opts = Object.assign({}, opts);
  const prev = opts.installGlobals;
  opts.installGlobals = function (w) {
    installApiStub(w, opts);
    if (typeof prev === 'function') prev(w);
  };
  return H.makeDom(opts);
}

/* 等待若干个微任务/宏任务，用于等前端的异步 API 流程落地 */
function tick(n) {
  n = n || 3;
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setTimeout(r, 0)));
  return p;
}

module.exports = Object.assign({}, H, {
  makeDom: makeDom,
  installApiStub: installApiStub,
  tick: tick,
  TOKEN_KEY: TOKEN_KEY
});
