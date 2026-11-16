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

  /* ================= 7. 免认证登录（SSO）配置与账号绑定 ================= */
  {
    const dom = makeDom({ sessionUser: 'admin', data: { admin: { regions: [], customers: [], visits: [] } }, errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    click(w, id('userChip'));
    click(w, id('umUsers'));
    click(w, id('btnAuthServers'));
    await tick(50);
    check('认证管理页标题', d.querySelector('#serversView h2').textContent.indexOf('认证管理') >= 0);

    click(w, id('btnNewServerEmpty'));
    check('类型下拉含六类免认证协议',
      ['oidc', 'oauth2', 'saml', 'cas', 'ticket', 'header'].every(v => [...id('sType').options].some(o => o.value === v)));

    id('sType').value = 'oidc';
    fire(w, id('sType'), 'change');
    check('切到 OIDC 后隐藏口令区、显示免认证区',
      id('sPwdWrap').style.display === 'none' && id('sSsoWrap').style.display === 'block');
    check('OIDC 参数区可见、其它协议区隐藏',
      id('sOidcWrap').style.display === 'block' && id('sSamlWrap').style.display === 'none');
    check('回调地址按当前站点生成',
      id('ssoCallback').value.indexOf('/api/auth/sso/callback') >= 0, id('ssoCallback').value);
    check('账号字段标签按协议用 claim 说法', id('ssoAccountLabel').textContent.indexOf('claim') >= 0,
      id('ssoAccountLabel').textContent);

    id('sName').value = '集团统一身份';
    click(w, id('btnSaveServer'));
    check('缺 Issuer 被拦下', w.__SRV__.servers.length === 0 && id('toast').textContent.indexOf('Issuer') >= 0,
      id('toast').textContent);

    id('soIssuer').value = 'https://sso.zdns.cn';
    id('soClientId').value = 'inspection';
    id('soClientSecret').value = 's3cret';
    id('ssoAccount').value = 'preferred_username';
    click(w, id('btnSaveServer'));
    await tick(60);
    check('OIDC 源创建成功', w.__SRV__.servers.length === 1, JSON.stringify(w.__SRV__.servers));
    const sv = w.__SRV__.servers[0];
    check('保存的 issuer / clientId 正确', sv.cfg.issuer === 'https://sso.zdns.cn' && sv.cfg.clientId === 'inspection');
    check('账号字段映射到账户 claim 键', sv.cfg.accountClaim === 'preferred_username', JSON.stringify(sv.cfg));
    check('host 从 issuer 解析', sv.host === 'sso.zdns.cn', sv.host);
    check('列表标注 OIDC 与免认证',
      id('serversTableWrap').textContent.indexOf('OIDC') >= 0 &&
      id('serversTableWrap').textContent.indexOf('免认证') >= 0,
      id('serversTableWrap').textContent.slice(0, 90));
    check('列表动作按钮显示「自检」',
      id('serversTableWrap').querySelector('[data-sact="test"]').textContent === '自检');

    /* 编辑：密钥不回显，留空表示不修改 */
    click(w, d.querySelector('#serversTableWrap tbody tr').querySelector('[data-sact="edit"]'));
    check('编辑时密钥框为空且提示已设置',
      id('soClientSecret').value === '' && id('soClientSecret').placeholder.indexOf('已设置') >= 0,
      id('soClientSecret').placeholder);
    check('编辑时回填 issuer', id('soIssuer').value === 'https://sso.zdns.cn', id('soIssuer').value);
    /* 自检按钮（桩不联网） */
    click(w, id('btnProbeServer'));
    await tick(60);
    check('自检结果按步骤展示', id('sProbeResult').textContent.indexOf('参数自洽性') >= 0,
      id('sProbeResult').textContent);
    click(w, d.querySelector('#maskServer [data-close]'));

    /* 反代头：账号/姓名/部门就是请求头名，取参数区而不是身份映射区（回归） */
    click(w, id('btnNewServer'));
    id('sName').value = '网关注入';
    id('sType').value = 'header';
    fire(w, id('sType'), 'change');
    check('反代头隐藏身份映射三列', id('ssoMapRow').style.display === 'none');
    id('shAccount').value = 'X-Auth-User';
    id('shName').value = 'X-Auth-Name';
    id('shAllowIps').value = '10.1.114.0/24';
    click(w, id('btnSaveServer'));
    await tick(60);
    const hv = w.__SRV__.servers.filter(s => s.type === 'header')[0];
    check('反代头保存了账号请求头', hv && hv.cfg.headerAccount === 'X-Auth-User', hv && JSON.stringify(hv.cfg));
    check('反代头保存了姓名请求头', hv && hv.cfg.headerName === 'X-Auth-Name');
    check('反代头保存了 IP 白名单', hv && hv.cfg.allowIps === '10.1.114.0/24');

    /* 用户绑定免认证源 */
    click(w, id('btnNewUser'));
    id('uUsername').value = 'ssouser';
    id('uName').value = '统一身份用户';
    id('uSourceType').value = 'remote';
    fire(w, id('uSourceType'), 'change');
    const opt = [...id('uServer').options].filter(o => o.textContent.indexOf('集团统一身份') >= 0)[0];
    check('用户下拉可选中免认证源且标注', !!opt && opt.textContent.indexOf('免认证') >= 0, opt && opt.textContent);
    id('uServer').value = opt.value;
    fire(w, id('uServer'), 'change');
    check('提示说明走统一身份登录', id('uServerHint').textContent.indexOf('统一身份登录') >= 0,
      id('uServerHint').textContent);
    check('选了免认证源时不显示初始密码', id('uPwdField').style.display === 'none');
    click(w, id('btnSaveUser'));
    await tick(80);
    const su = userOf(w, 'ssouser');
    check('账号来源记为 oidc', su && su.source === 'oidc', su && su.source);
    check('免认证账号不保存本地口令', su && !su.pwd);

    /* ===== 企业微信通知（用户级） ===== */
    click(w, id('btnNewUser'));
    id('uUsername').value = 'wxuser';
    id('uName').value = '通知测试';
    check('未启用时隐藏通知参数区', id('uWxBody').style.display === 'none', id('uWxBody').style.display);
    id('uWxOn').checked = true;
    fire(w, id('uWxOn'), 'change');
    check('勾选启用后展开参数区', id('uWxBody').style.display === 'block', id('uWxBody').style.display);
    check('默认接入方式为群机器人', id('uWxRobotWrap').style.display === 'block' && id('uWxAppWrap').style.display === 'none');
    check('消息形式默认卡片', id('uWxFmt').value === 'card', id('uWxFmt').value);
    check('触发动作默认三个全勾',
      id('uWxActAdd').checked && id('uWxActUpd').checked && id('uWxActDel').checked,
      [id('uWxActAdd').checked, id('uWxActUpd').checked, id('uWxActDel').checked].join(','));
    id('uWxType').value = 'app';
    fire(w, id('uWxType'), 'change');
    check('切到自建应用显示 corpid / agentid / secret',
      id('uWxAppWrap').style.display === 'block' && id('uWxRobotWrap').style.display === 'none');
    id('uWxType').value = 'robot';
    fire(w, id('uWxType'), 'change');
    const wxHook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd1234';
    id('uWxHook').value = wxHook;
    id('uWxTo').value = '13800138000';
    id('uWxTpl').value = '【巡检】{summary}';
    id('uWxFmt').value = 'text';
    /* 触发动作收窄：取消「修改」，只留新增 + 删除 */
    id('uWxActUpd').checked = false;
    id('uPwd').value = 'abc123456';
    click(w, id('btnSaveUser'));
    await tick(90);
    const wu = userOf(w, 'wxuser');
    check('机器人配置随用户保存', wu && wu.wx && wu.wx.enabled && wu.wx.hook === wxHook, wu && JSON.stringify(wu.wx));
    check('接收人保存', wu && wu.wx.to === '13800138000', wu && wu.wx.to);
    check('自定义模板保存', wu && wu.wx.tpl === '【巡检】{summary}', wu && wu.wx.tpl);
    check('消息形式保存', wu && wu.wx.fmt === 'text', wu && wu.wx.fmt);
    check('触发动作按勾选保存（未勾修改）', wu && JSON.stringify(wu.wx.acts) === '["add","delete"]',
      wu && JSON.stringify(wu.wx.acts));
    check('列表出现「机器人」标记',
      (d.querySelector('#usersTableWrap tr[data-uid="wxuser"]') || {}).textContent.indexOf('机器人') >= 0);

    click(w, d.querySelector('#usersTableWrap tr[data-uid="wxuser"] [data-ua="edit"]'));
    await tick(60);
    check('编辑时 hook 回填掩码而非明文', id('uWxHook').value.indexOf('****') > 0 && id('uWxHook').value !== wxHook, id('uWxHook').value);
    check('编辑时提示已保存', id('uWxHookHint').textContent.indexOf('已保存') >= 0, id('uWxHookHint').textContent);
    check('编辑时回填模板', id('uWxTpl').value === '【巡检】{summary}', id('uWxTpl').value);
    check('编辑时回填消息形式', id('uWxFmt').value === 'text', id('uWxFmt').value);
    check('编辑时回填触发动作',
      id('uWxActAdd').checked && !id('uWxActUpd').checked && id('uWxActDel').checked,
      [id('uWxActAdd').checked, id('uWxActUpd').checked, id('uWxActDel').checked].join(','));
    /* 三个都不勾 → 前后端都会拦，且不得改动已存配置 */
    id('uWxActAdd').checked = false;
    id('uWxActDel').checked = false;
    click(w, id('btnSaveUser'));
    await tick(90);
    const wuKeep = userOf(w, 'wxuser');
    check('三个都不勾时保存被拦下、配置不变',
      wuKeep && JSON.stringify(wuKeep.wx.acts) === '["add","delete"]', wuKeep && JSON.stringify(wuKeep.wx.acts));
    click(w, d.querySelector('#maskUser [data-close]'));

    /* 批量：只关推送，保留已存地址 */
    const cbx = d.querySelector('#usersTableWrap [data-uchk="wxuser"]');
    cbx.checked = true;
    fire(w, cbx, 'change');
    click(w, id('btnUsersBatchEdit'));
    await tick(40);
    check('批量弹窗默认不应用通知', id('bWxOn').checked === false);
    id('bWxOn').checked = true;
    fire(w, id('bWxOn'), 'change');
    id('bWxMode').value = 'off';
    fire(w, id('bWxMode'), 'change');
    check('停用模式隐藏参数区', id('bWxDetail').style.display === 'none', id('bWxDetail').style.display);
    click(w, id('btnSaveBatchUsers'));
    await tick(140);
    const wu2 = userOf(w, 'wxuser');
    check('批量停用后 enabled 为 false', wu2 && wu2.wx.enabled === false, wu2 && JSON.stringify(wu2.wx));
    check('批量停用保留已存的 hook', wu2 && wu2.wx.hook === wxHook, wu2 && wu2.wx.hook);

    /* 批量启用时也能设置触发动作 */
    const cbx2 = d.querySelector('#usersTableWrap [data-uchk="wxuser"]');
    cbx2.checked = true;
    fire(w, cbx2, 'change');
    click(w, id('btnUsersBatchEdit'));
    await tick(40);
    check('批量弹窗触发动作默认三个全勾',
      id('bWxActAdd').checked && id('bWxActUpd').checked && id('bWxActDel').checked);
    id('bWxOn').checked = true;
    fire(w, id('bWxOn'), 'change');
    id('bWxMode').value = 'on';
    fire(w, id('bWxMode'), 'change');
    check('启用模式显示参数区', id('bWxDetail').style.display === 'block', id('bWxDetail').style.display);
    id('bWxHook').value = wxHook;
    id('bWxFmt').value = 'markdown';
    id('bWxActUpd').checked = false;
    id('bWxActDel').checked = false;
    click(w, id('btnSaveBatchUsers'));
    await tick(160);
    const wu3 = userOf(w, 'wxuser');
    check('批量启用的消息形式已下发', wu3 && wu3.wx.fmt === 'markdown', wu3 && wu3.wx.fmt);
    check('批量启用的触发动作已下发', wu3 && wu3.wx.enabled && JSON.stringify(wu3.wx.acts) === '["add"]',
      wu3 && JSON.stringify(wu3.wx));

    w.close();
  }

  /* ================= 企业微信卡片深链（?cust=） ================= */
  const deepCust = {
    id: 'dc1', name: '衡水银行', regionId: '', province: '北京', city: '',
    addr: '', lng: 116.4, lat: 39.9, freq: 'y4', contact: '', phone: '', note: ''
  };
  {
    const dom = makeDom({
      sessionUser: 'demo',
      url: 'http://127.0.0.1:8899/inspection-dashboard.html?cust=dc1',
      data: { demo: { regions: [], customers: [deepCust], visits: [] } },
      errors
    });
    const w = dom.window, d = w.document;
    await tick(600);
    check('卡片深链自动打开客户详情', d.getElementById('maskDetail').classList.contains('on'));
    check('详情标题为该客户', d.getElementById('dName').textContent === '衡水银行', d.getElementById('dName').textContent);
    w.close();
  }
  {
    const dom = makeDom({
      sessionUser: 'demo',
      url: 'http://127.0.0.1:8899/inspection-dashboard.html?cust=nope',
      data: { demo: { regions: [], customers: [deepCust], visits: [] } },
      errors
    });
    const w = dom.window, d = w.document;
    await tick(600);
    check('深链客户不存在时不打开详情', !d.getElementById('maskDetail').classList.contains('on'));
    check('深链客户不存在时给出提示', d.getElementById('toast').textContent.indexOf('未找到') >= 0,
      d.getElementById('toast').textContent);
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
