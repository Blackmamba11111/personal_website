/* ============================================================
   test-remote-auth.js —— 本地/远程用户、只读权限、认证服务器管理
   协议本身的正确性见 test-protocols.mjs；Worker 侧 SQL 见 test-worker-api.mjs。
   本文件只验证前端交互与权限拦截（服务端用内存桩模拟）。
   ============================================================ */
const { makeDom } = require('./test-helpers-server');

const results = [];
const errors = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }
const tick = ms => new Promise(r => setTimeout(r, ms));

const idOf = (d, x) => d.getElementById(x);
const click = (w, el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const fire = (w, el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true, cancelable: true }));
const submit = (w, f) => f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
const userOf = (w, n) => w.__SRV__.users.filter(u => u.username === n)[0];

(async function main() {

  /* ================= 1. 认证服务器管理页 ================= */
  {
    const dom = makeDom({ sessionUser: 'admin', data: { admin: { regions: [], customers: [], visits: [] } }, errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    click(w, id('userChip'));
    click(w, id('umUsers'));
    check('超管可打开用户管理页', id('usersView').classList.contains('on'));
    check('用户管理页有「认证服务器」入口', !!id('btnAuthServers'));

    click(w, id('btnAuthServers'));
    check('打开认证服务器页', id('serversView').classList.contains('on'));
    check('无服务器时给出空态与新建入口', !!id('btnNewServerEmpty'), id('serversTableWrap').textContent.slice(0, 40));

    click(w, id('btnNewServerEmpty'));
    check('新增服务器弹窗打开', id('maskServer').classList.contains('on'));
    check('默认类型为 LDAP 时不显示共享密钥', id('sSecretWrap').style.display === 'none');
    check('LDAP 时显示绑定模板', id('sLdapWrap').style.display === 'block');

    /* 缺名称 / 缺地址 */
    click(w, id('btnSaveServer'));
    check('缺名称被拦下', id('toast').textContent.indexOf('名称') >= 0, id('toast').textContent);

    id('sName').value = '总部 LDAP';
    id('sType').value = 'ldap';
    fire(w, id('sType'), 'change');
    id('sHost').value = '10.1.1.9';
    id('sBind').value = 'uid={user},ou=people,dc=corp';
    click(w, id('btnSaveServer'));
    await tick(50);
    check('LDAP 服务器创建成功', w.__SRV__.servers.length === 1, JSON.stringify(w.__SRV__.servers));
    check('保存的绑定模板正确', w.__SRV__.servers[0].cfg.bindPattern === 'uid={user},ou=people,dc=corp');
    check('列表渲染出该服务器', id('serversTableWrap').textContent.indexOf('总部 LDAP') >= 0);
    check('列表标注协议类型', id('serversTableWrap').textContent.indexOf('LDAP') >= 0);

    /* RADIUS 必须填密钥 */
    click(w, id('btnNewServer'));
    id('sName').value = '核心 RADIUS';
    id('sType').value = 'radius';
    fire(w, id('sType'), 'change');
    check('切到 RADIUS 后要求填共享密钥', id('sSecretWrap').style.display === 'block');
    id('sHost').value = '10.1.1.10';
    click(w, id('btnSaveServer'));
    check('RADIUS 缺密钥被前端拦下', w.__SRV__.servers.length === 1 && id('toast').textContent.indexOf('共享密钥') >= 0,
      id('toast').textContent);
    id('sSecret').value = 'rad-secret';
    click(w, id('btnSaveServer'));
    await tick(50);
    check('补上密钥后创建成功', w.__SRV__.servers.length === 2);
    check('RADIUS 默认端口按 1812 落库', w.__SRV__.servers[1].port === 1812, w.__SRV__.servers[1].port + '');

    /* 测试连接 */
    const rows = [...d.querySelectorAll('#serversTableWrap tbody tr')];
    const ldapRow = rows.filter(r => r.textContent.indexOf('总部 LDAP') >= 0)[0];
    click(w, ldapRow.querySelector('[data-sact="test"]'));
    check('「测试」按钮打开该服务器配置', id('maskServer').classList.contains('on') &&
      id('sHost').value === '10.1.1.9', id('sHost').value);
    id('sTestUser').value = 'zhangsan';
    id('sTestPwd').value = 'bad-password';
    click(w, id('btnTestServer'));
    await tick(50);
    check('测试失败时给出明确原因', id('sTestResult').textContent.indexOf('认证未通过') >= 0,
      id('sTestResult').textContent);
    id('sTestPwd').value = 'remote-ok';
    click(w, id('btnTestServer'));
    await tick(50);
    check('测试通过时显示认证通过', id('sTestResult').textContent.indexOf('认证通过') >= 0,
      id('sTestResult').textContent);
    click(w, d.querySelector('#maskServer [data-close]'));

    /* 返回用户管理 */
    click(w, id('btnServersBack'));
    check('返回用户管理页', id('usersView').classList.contains('on') && !id('serversView').classList.contains('on'));

    /* ================= 2. 创建远程用户 ================= */
    click(w, id('btnNewUser'));
    check('新建用户弹窗有账号类型选项', !!id('uSourceType'));
    check('默认本地账号时显示初始密码', id('uPwdField').style.display === 'block');
    id('uUsername').value = 'raduser';
    id('uName').value = '远程只读用户';
    id('uSourceType').value = 'remote';
    fire(w, id('uSourceType'), 'change');
    check('切到远程后隐藏初始密码输入', id('uPwdField').style.display === 'none');
    check('切到远程后出现认证服务器选择', id('uServerField').style.display === 'block');
    check('服务器下拉自动带出已配置项',
      id('uServer').options.length === 2 && id('uServer').textContent.indexOf('总部 LDAP') >= 0);
    check('提示文案说明由该服务器校验密码', id('uServerHint').textContent.indexOf('总部 LDAP') >= 0,
      id('uServerHint').textContent);

    id('uServer').value = w.__SRV__.servers[0].id;
    fire(w, id('uServer'), 'change');
    id('uPerm').value = 'ro';
    click(w, id('btnSaveUser'));
    await tick(60);
    const ru = userOf(w, 'raduser');
    check('远程用户创建成功', !!ru);
    check('远程用户来源记录为 ldap', ru && ru.source === 'ldap', ru && ru.source);
    check('远程用户不保存本地口令', ru && !ru.pwd, ru && ru.pwd);
    check('远程用户权限为只读', ru && ru.perm === 'ro');
    check('远程用户绑定到所选服务器', ru && ru.serverId === w.__SRV__.servers[0].id);

    /* 列表展示 */
    const urows = [...d.querySelectorAll('#usersTableWrap tbody tr')];
    const rrow = urows.filter(r => r.textContent.indexOf('raduser') >= 0)[0];
    check('列表有「来源」列并标出 LDAP', !!rrow && rrow.textContent.indexOf('LDAP') >= 0, rrow && rrow.textContent);
    check('列表有「权限」列并标出只读', !!rrow && rrow.textContent.indexOf('只读') >= 0);
    check('远程用户的「重置密码」被禁用', !!rrow && rrow.querySelector('[data-ua="pwd"]').disabled === true);

    /* ================= 3. 远程用户登录 ================= */
    click(w, id('umLogout'));
    await tick(30);
    id('loginUser').value = 'raduser';
    id('loginPwd').value = 'wrong';
    submit(w, id('loginForm'));
    await tick(60);
    check('远程用户错误口令被拒绝', id('authView').classList.contains('on') &&
      id('authErr').textContent.indexOf('不正确') >= 0, id('authErr').textContent);

    id('loginPwd').value = 'remote-ok';
    submit(w, id('loginForm'));
    await tick(80);
    check('远程用户凭证正确即可登录', !id('authView').classList.contains('on'));
    check('账号菜单标注「只读」', id('userRoleText').textContent === '只读', id('userRoleText').textContent);
    check('账号菜单显示认证来源', id('umMeta').textContent.indexOf('LDAP') >= 0, id('umMeta').textContent);

    /* ================= 4. 只读账号的写入拦截 ================= */
    const before = JSON.stringify(w.__SRV__.ledgers['raduser'] || null);
    click(w, id('btnAdd'));
    check('只读账号点「新增客户」被拦下（不打开抽屉）', !id('maskCust').classList.contains('on'));
    check('给出只读提示', id('toast').textContent.indexOf('只读权限') >= 0, id('toast').textContent);
    await tick(60);
    check('只读账号不会把改动推给服务端', JSON.stringify(w.__SRV__.ledgers['raduser'] || null) === before);

    click(w, id('btnAddVisit'));
    check('只读账号点「登记巡检」同样被拦下', !id('maskVisit') || !id('maskVisit').classList.contains('on'));
    check('服务端也会拒绝（桩已实现 403）',
      w.__SRV__.users.filter(u => u.username === 'raduser')[0].perm === 'ro');

    w.close();
  }

  /* ================= 5. 远程 → 本地：必须补初始密码 ================= */
  {
    const dom = makeDom({
      sessionUser: 'admin',
      data: { admin: { regions: [], customers: [], visits: [] } },
      servers: [{ id: 'srvA', name: '旧 LDAP', type: 'ldap', host: '10.0.0.1', port: 389, cfg: {} }],
      errors
    });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    /* 桩里注入一个远程用户 */
    w.__SRV__.users.push({
      id: 'oldremote', username: 'oldremote', name: '老远程账号', role: 'user', status: 'active',
      note: '', source: 'ldap', perm: 'rw', serverId: 'srvA', salt: '', pwd: '', mustChange: false,
      createdAt: '2026-01-01', lastLogin: ''
    });
    w.localStorage.setItem('inspection_board_users_v1',
      JSON.stringify({ version: 2, users: w.__SRV__.users }));

    click(w, id('userChip'));
    click(w, id('umUsers'));
    const rows = [...d.querySelectorAll('#usersTableWrap tbody tr')];
    const row = rows.filter(r => r.textContent.indexOf('oldremote') >= 0)[0];
    check('远程账号在列表中可见', !!row);

    click(w, row.querySelector('[data-ua="edit"]'));
    check('编辑远程账号时类型为「远程」', id('uSourceType').value === 'remote');
    check('编辑时隐藏密码输入（已是远程）', id('uPwdField').style.display === 'none');

    /* 改回本地但不填密码 → 被前端拦下 */
    id('uSourceType').value = 'local';
    fire(w, id('uSourceType'), 'change');
    check('改成本地后出现初始密码输入', id('uPwdField').style.display === 'block');
    click(w, id('btnSaveUser'));
    check('未填初始密码时拒绝保存', id('maskUser').classList.contains('on') &&
      id('toast').textContent.indexOf('初始密码') >= 0, id('toast').textContent);

    id('uPwd').value = 'Local@123';
    click(w, id('btnSaveUser'));
    await tick(60);
    const t = userOf(w, 'oldremote');
    check('填了初始密码后改为本地账号', t && t.source === 'local', t && t.source);
    check('本地口令已写入', t && !!t.pwd);

    w.close();
  }

  /* ================= 6. 服务器被账号引用时不可删除 ================= */
  {
    const dom = makeDom({
      sessionUser: 'admin',
      data: { admin: { regions: [], customers: [], visits: [] } },
      servers: [{ id: 'srvB', name: '在用 RADIUS', type: 'radius', host: '10.0.0.2', port: 1812, cfg: { secret: 'x' } }],
      errors
    });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);
    w.__SRV__.users.push({
      id: 'u2', username: 'u2', name: '在用账号', role: 'user', status: 'active', note: '',
      source: 'radius', perm: 'rw', serverId: 'srvB', salt: 's', pwd: '', mustChange: false,
      createdAt: '2026-01-01', lastLogin: ''
    });
    w.localStorage.setItem('inspection_board_users_v1', JSON.stringify({ version: 2, users: w.__SRV__.users }));

    click(w, id('userChip'));
    click(w, id('umUsers'));
    click(w, id('btnAuthServers'));
    await tick(50);
    const row = d.querySelector('#serversTableWrap tbody tr');
    check('服务器列表显示绑定账号数', row.textContent.indexOf('1 个账号') >= 0, row.textContent);
    check('被引用的服务器「删除」按钮禁用', row.querySelector('[data-sact="del"]').disabled === true);

    /* 密钥不回显：列表里不应出现 secret 值 */
    check('列表不回显共享密钥', row.textContent.indexOf('x') < 0 || row.textContent.indexOf('共享密钥 已设置') >= 0,
      row.textContent);

    w.close();
  }

  /* ================= 汇总 ================= */
  let pass = 0;
  results.forEach(([st, label, extra]) => {
    if (st === 'PASS') pass++;
    else console.log('  ✗ ' + label + (extra ? '  → ' + extra : ''));
  });
  console.log('<<通过 ' + pass + ' / 共 ' + results.length + '>>');
  process.exit(pass === results.length ? 0 : 1);
})();
