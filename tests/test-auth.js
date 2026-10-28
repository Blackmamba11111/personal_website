/* ============================================================
   test-auth.js —— V2 登录 / 权限 / 数据隔离 / 用户管理 回归测试
   ============================================================ */
const { makeDom, mkUser, fixture, dataKey, hashPwd, SCOPE_ALL } = require('./test-helpers-server');

const results = [];
const errors = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }
const tick = ms => new Promise(r => setTimeout(r, ms));

/* 构造一个小台账 */
function mkDB(n, prefix) {
  return {
    regions: [{ id: 'r1', name: '片区', color: '#2563EB', provinces: ['河北'] }],
    customers: Array.from({ length: n }, (_, i) => ({
      id: prefix + 'c' + i, name: prefix + '客户' + i, regionId: 'r1', province: '河北',
      city: '衡水', addr: '', lng: 115.7 + i * 0.01, lat: 37.7, freq: 'y4',
      contact: '', phone: '', note: '', hasCoords: true
    })),
    visits: []
  };
}
const idOf = (d, x) => d.getElementById(x);
const click = (w, el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const fire = (w, el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true, cancelable: true }));
const submit = (w, form) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
const usersOf = w => JSON.parse(w.localStorage.getItem('inspection_board_users_v1')).users;

(async function main() {

  /* ================= 1. 登录门禁 ================= */
  {
    const dom = makeDom({ sessionUser: null, errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    check('未登录时展示登录页', id('authView').classList.contains('on'));
    check('未登录时看板不渲染客户', id('stTotal').textContent === '0', id('stTotal').textContent);

    click(w, id('btnAdd'));
    check('未登录时写操作未绑定（不打开抽屉）', !id('maskCust').classList.contains('on'));

    submit(w, id('loginForm'));
    check('空用户名/密码给出提示', id('authErr').classList.contains('on')
      && id('authErr').textContent.indexOf('请输入') >= 0, id('authErr').textContent);

    id('loginUser').value = 'demo';
    id('loginPwd').value = 'wrong-password';
    submit(w, id('loginForm'));
    await tick(40);   /* 登录改走 /api/auth/login，需等异步返回 */
    check('密码错误被拒绝', id('authView').classList.contains('on')
      && id('authErr').textContent.indexOf('不正确') >= 0, id('authErr').textContent);

    id('loginUser').value = 'no-such-user';
    id('loginPwd').value = 'whatever';
    submit(w, id('loginForm'));
    await tick(40);
    check('不存在的用户名同样报「不正确」（不泄露账号是否存在）',
      id('authErr').textContent.indexOf('不正确') >= 0, id('authErr').textContent);

    id('loginUser').value = 'demo';
    id('loginPwd').value = 'demo888';
    /* 2026-10-26：登录页已移除「记住登录」，令牌固定写入 sessionStorage */
    submit(w, id('loginForm'));
    await tick(60);
    check('正确密码登录成功', !id('authView').classList.contains('on'));
    check('登录后加载到自己的台账（14 家示例客户）', id('stTotal').textContent === '14', id('stTotal').textContent);
    check('登录后持有服务端签发的会话令牌（仅 sessionStorage，不落 localStorage）',
      !!w.sessionStorage.getItem('inspection_board_token_v1')
      && !w.localStorage.getItem('inspection_board_token_v1'));
    check('普通用户账号标识正确', id('userRoleText').textContent === '普通用户', id('userRoleText').textContent);
    w.close();
  }

  /* ================= 2. 停用账号 / 会话失效 ================= */
  {
    const fx = { version: 1, users: [
      mkUser({ username: 'admin', name: '超级管理员', role: 'admin', password: 'admin888' }),
      mkUser({ username: 'off', name: '已停用用户', role: 'user', password: 'off888', status: 'disabled' })
    ] };
    const dom = makeDom({ fixture: fx, sessionUser: null, errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);
    id('loginUser').value = 'off';
    id('loginPwd').value = 'off888';
    submit(w, id('loginForm'));
    await tick(40);
    check('停用账号拒绝登录并说明原因', id('authView').classList.contains('on')
      && id('authErr').textContent.indexOf('停用') >= 0, id('authErr').textContent);
    w.close();
  }
  {
    /* 会话指向已被停用的账号 → 应回落到登录页 */
    const fx = { version: 1, users: [
      mkUser({ username: 'admin', name: '超级管理员', role: 'admin', password: 'admin888' }),
      mkUser({ username: 'off', name: '已停用用户', role: 'user', password: 'off888', status: 'disabled' })
    ] };
    const dom = makeDom({ fixture: fx, sessionUser: 'off', errors });
    await tick(260);
    check('存量会话对应的账号被停用后，直接回到登录页',
      dom.window.document.getElementById('authView').classList.contains('on'));
    dom.window.close();
  }

  /* ================= 3. 普通用户权限边界 ================= */
  {
    const dom = makeDom({ sessionUser: 'demo', errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    click(w, id('userChip'));
    check('账号菜单可打开', id('userMenu').classList.contains('on'));
    check('普通用户菜单不显示「用户管理」入口', id('umUsers').style.display === 'none',
      'display=' + id('umUsers').style.display);
    check('普通用户菜单不显示「数据范围」选择器', id('umScopeWrap').style.display === 'none');
    click(w, id('umUsers'));
    check('普通用户即便触发入口也进不了用户管理页', !id('usersView').classList.contains('on'));
    w.close();
  }

  /* ================= 4. 超管：汇总视图（只读） ================= */
  {
    const dom = makeDom({
      sessionUser: 'admin',
      data: { admin: mkDB(2, 'A-'), demo: mkDB(3, 'B-') },
      errors
    });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    check('超管默认进入汇总视图', id('roBanner').classList.contains('on'));
    check('汇总视图合并全部账号数据（2+3=5）', id('stTotal').textContent === '5', id('stTotal').textContent);
    check('汇总视图按账号拆分区域（全部 + 2 个）',
      d.querySelectorAll('#regionChips .chip').length === 3,
      d.querySelectorAll('#regionChips .chip').length + ' 个 chip');
    check('汇总视图账号标识显示「汇总」', id('userRoleText').textContent === '汇总', id('userRoleText').textContent);
    check('汇总视图列表出现账号前缀分组',
      id('custList').textContent.indexOf('超级管理员 · 片区') >= 0
      && id('custList').textContent.indexOf('演示用户 · 片区') >= 0);

    const before = {
      admin: w.localStorage.getItem(dataKey('admin')),
      demo: w.localStorage.getItem(dataKey('demo'))
    };
    click(w, id('btnAdd'));
    check('汇总视图拦截「新增客户」', !id('maskCust').classList.contains('on'));
    check('汇总视图给出只读提示', id('toast').textContent.indexOf('只读') >= 0, id('toast').textContent);
    click(w, id('btnRegions'));
    check('汇总视图拦截「区域设置」', !id('maskRegion').classList.contains('on'));
    check('拦截后各账号台账未被写入',
      w.localStorage.getItem(dataKey('admin')) === before.admin
      && w.localStorage.getItem(dataKey('demo')) === before.demo);
    w.close();
  }

  /* ================= 5. 超管：切换到具体用户（可编辑）+ 数据隔离 ================= */
  {
    const dom = makeDom({
      sessionUser: 'admin',
      data: { admin: mkDB(2, 'A-'), demo: mkDB(3, 'B-') },
      errors
    });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    id('scopeSel').value = 'demo';
    fire(w, id('scopeSel'), 'change');
    await tick(40);
    check('切换到具体用户后只读横幅消失', !id('roBanner').classList.contains('on'));
    check('切换到「演示用户」后数据为该用户台账（3 家）', id('stTotal').textContent === '3', id('stTotal').textContent);
    check('切换后账号标识回到角色名', id('userRoleText').textContent === '超级管理员', id('userRoleText').textContent);

    /* 在该用户台账下新增客户 → 只影响该用户存储 */
    const adminBefore = w.localStorage.getItem(dataKey('admin'));
    click(w, id('btnAdd'));
    check('切换到具体用户后可编辑（抽屉打开）', id('maskCust').classList.contains('on'));
    id('fName').value = '超管代录客户';
    click(w, id('btnSaveCust'));
    await tick(40);
    const demoDB = JSON.parse(w.localStorage.getItem(dataKey('demo')));
    check('新增写入到被切换用户的台账', demoDB.customers.length === 4, demoDB.customers.length + ' 家');
    check('新增不会污染超管自己的台账',
      w.localStorage.getItem(dataKey('admin')) === adminBefore);
    check('新增不会污染其他账号', JSON.parse(w.localStorage.getItem(dataKey('demo'))).customers
      .filter(c => c.name === '超管代录客户').length === 1);
    w.close();
  }

  /* ================= 6. 用户管理：新建 / 校验 / 唯一性 ================= */
  {
    const dom = makeDom({ sessionUser: 'admin', data: { admin: mkDB(1, 'A-') }, errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    click(w, id('userChip'));
    click(w, id('umUsers'));
    check('超管可打开用户管理页', id('usersView').classList.contains('on'));
    check('用户列表行数 = 2', d.querySelectorAll('#usersTableWrap tbody tr').length === 2,
      d.querySelectorAll('#usersTableWrap tbody tr').length + ' 行');

    /* 用户名非法 */
    click(w, id('btnNewUser'));
    check('新建用户弹窗打开', id('maskUser').classList.contains('on'));
    id('uUsername').value = 'ab';                 // 太短
    id('uName').value = '张三';
    id('uPwd').value = 'zhang888';
    click(w, id('btnSaveUser'));
    check('用户名过短被拒绝', usersOf(w).length === 2 && id('maskUser').classList.contains('on'));
    check('给出用户名规则提示', id('toast').textContent.indexOf('3–32') >= 0, id('toast').textContent);

    /* 用户名重复 */
    id('uUsername').value = 'demo';
    click(w, id('btnSaveUser'));
    check('用户名重复被拒绝', usersOf(w).length === 2);
    check('给出重名提示', id('toast').textContent.indexOf('已存在') >= 0, id('toast').textContent);

    /* 密码过短 */
    id('uUsername').value = 'zhangsan';
    id('uPwd').value = '123';
    click(w, id('btnSaveUser'));
    check('密码过短被拒绝', usersOf(w).length === 2);
    check('给出密码长度提示', id('toast').textContent.indexOf('6 位') >= 0, id('toast').textContent);

    /* 正常创建（复制示例数据） */
    id('uPwd').value = 'zhang888';
    id('uNote').value = '河北片区';
    id('uSeed').value = 'demo';
    click(w, id('btnSaveUser'));
    await tick(40);
    check('创建成功后用户数 = 3', usersOf(w).length === 3, usersOf(w).length + '');
    check('新用户角色为普通用户', usersOf(w).filter(u => u.username === 'zhangsan')[0].role === 'user');
    check('弹窗已关闭', !id('maskUser').classList.contains('on'));
    const zs = w.__SRV__.ledgers['zhangsan'];
    check('新用户台账已按选项初始化（复制示例数据 = 14 家）', zs && zs.customers.length === 14,
      zs ? zs.customers.length + ' 家' : '无台账');
    check('用户列表刷新为 3 行', d.querySelectorAll('#usersTableWrap tbody tr').length === 3);

    /* 空台账选项 */
    click(w, id('btnNewUser'));
    id('uUsername').value = 'lisi';
    id('uName').value = '李四';
    id('uPwd').value = 'lisi8888';
    id('uSeed').value = 'empty';
    click(w, id('btnSaveUser'));
    await tick(40);
    const ls = w.__SRV__.ledgers['lisi'];
    check('选择空台账时新用户数据为空', !!ls && ls.customers.length === 0 && ls.regions.length === 0);

    /* 共享现有用户数据：wangwu 与 zhangsan 共用同一份台账（双向同步） */
    click(w, id('btnNewUser'));
    await tick(60);                           /* 等来源下拉的回源刷新完成 */
    check('初始数据含「共享现有用户」选项', id('uSeed').textContent.indexOf('共享现有用户') >= 0);
    check('默认隐藏来源用户下拉', id('uSeedCopyWrap').style.display === 'none');
    id('uUsername').value = 'wangwu';
    id('uName').value = '王五';
    id('uPwd').value = 'wangw888';
    id('uSeed').value = 'copy';
    id('uSeed').dispatchEvent(new w.Event('change', { bubbles: true }));
    check('选择共享后显示来源用户下拉', id('uSeedCopyWrap').style.display === 'block');
    check('来源下拉已列出用户并带数据量', id('uSeedUser').textContent.indexOf('zhangsan') >= 0 &&
      id('uSeedUser').textContent.indexOf('14 家客户') >= 0, id('uSeedUser').textContent.slice(0, 120));
    id('uSeedUser').value = 'zhangsan';
    click(w, id('btnSaveUser'));
    await tick(60);
    check('共享创建成功（用户数 = 5）', usersOf(w).length === 5, usersOf(w).length + '');
    const wwView = usersOf(w).filter(u => u.username === 'wangwu')[0];
    check('wangwu 记录了共享来源', wwView.shareFrom === 'zhangsan', JSON.stringify(wwView.shareFrom));
    check('zhangsan 的共享成员含 wangwu',
      usersOf(w).filter(u => (u.shareFrom || '') === 'zhangsan').map(u => u.username).indexOf('wangwu') >= 0);
    check('共享不复制数据（wangwu 无独立台账）', !w.__SRV__.ledgers['wangwu']);
    check('来源用户数据不受影响', w.__SRV__.ledgers['zhangsan'].customers.length === 14);
    check('共享创建后弹窗已关闭', !id('maskUser').classList.contains('on'));

    /* 双向同步：admin 改 zhangsan 的台账后，wangwu 读取到同一份数据 */
    const zData = JSON.parse(JSON.stringify(w.__SRV__.ledgers['zhangsan']));
    zData.customers[0].phone = '13900000000';                 /* 修改 → 触发字段级明细 */
    zData.customers.push({ id: 'c-new', name: '同步测试客户', regionId: '', province: '', city: '', addr: '', lng: 114.5, lat: 38.0, freq: { type: 'month', times: 1 }, contact: '', phone: '', note: '' });
    await w.fetch('/api/ledger', { method: 'PUT', body: JSON.stringify({ scope: 'zhangsan', data: zData }), headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' } });
    const snap = await (await w.fetch('/api/ledger')).json();
    check('owner 数据已更新（15 家）', w.__SRV__.ledgers['zhangsan'].customers.length === 15);
    check('共享成员读取到同一份数据（15 家）', snap.ok && snap.data.ledgers['wangwu'] &&
      snap.data.ledgers['wangwu'].customers.length === 15,
      snap.ok ? Object.keys(snap.data.ledgers['wangwu'].customers.length ? { n: 1 } : {}).length + '' : '无');

    /* 数据日志：操作人 / 对象 / 动作 / 字段级明细 */
    const lj = await (await w.fetch('/api/logs?username=wangwu')).json();
    check('共享成员按归属者查到日志', lj.ok && lj.data.owner === 'zhangsan', JSON.stringify(lj.data && lj.data.owner));
    const addLog = lj.data.logs.filter(l => l.kind === 'customer' && l.action === 'add')[0];
    check('日志记录了新增客户与操作人', !!addLog && addLog.actor === 'admin' && addLog.target === '同步测试客户',
      JSON.stringify(addLog));
    check('日志记录了字段级明细', lj.data.logs.some(l => l.detail.indexOf('联系电话：空 → 13900000000') >= 0),
      JSON.stringify(lj.data.logs.slice(0, 3)));

    /* 数据日志页：按数据集筛选展示 */
    click(w, id('btnDataLogs'));
    await tick(40);
    check('数据日志页已打开', id('logsView').classList.contains('on'));
    id('logsScope').value = 'wangwu';         /* 成员入口 → 解析到 zhangsan 的数据集 */
    id('logsScope').dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(40);
    check('日志页解析共享归属并展示记录', id('logsSub').textContent.indexOf('zhangsan') >= 0 &&
      d.querySelectorAll('#logsTableWrap tbody tr').length >= 2,
      id('logsSub').textContent + ' / ' + d.querySelectorAll('#logsTableWrap tbody tr').length + ' 行');
    check('日志页含变更明细列', id('logsTableWrap').textContent.indexOf('客户') >= 0);

    /* 删除共享 owner：数据与成员转移给最早的成员 */
    click(w, id('btnLogsBack'));
    await tick(20);
    const rows2 = [...d.querySelectorAll('#usersTableWrap tbody tr')];
    /* 用户列表默认按显示名称排序，wangwu（王五）会排在 zhangsan（张三）前，
       且 wangwu 行含「共享自 zhangsan」字样 → 须排除共享行，精确定位来源行 */
    const zsRow2 = rows2.filter(r => r.textContent.indexOf('zhangsan') >= 0 && r.textContent.indexOf('共享自') < 0)[0];
    click(w, zsRow2.querySelector('[data-ua="del"]'));
    click(w, id('cfOk'));
    await tick(40);
    const wwAfter = usersOf(w).filter(u => u.username === 'wangwu')[0];
    check('删除 owner 后成员转正（wangwu 成为归属者）',
      !(wwAfter.shareFrom || '').length &&
      usersOf(w).filter(u => (u.shareFrom || '') === 'wangwu').length === 0,
      JSON.stringify(wwAfter.shareFrom));
    check('数据转移给成员（15 家保留）', (w.__SRV__.ledgers['wangwu'] || { customers: [] }).customers.length === 15,
      String((w.__SRV__.ledgers['wangwu'] || { customers: [] }).customers.length));
    /* 自我保护：不能删除自己 */
    const rows = [...d.querySelectorAll('#usersTableWrap tbody tr')];
    const adminRow = rows.filter(r => r.textContent.indexOf('admin') >= 0)[0];
    const selfDel = adminRow.querySelector('[data-ua="del"]');
    check('不能删除当前登录账号（按钮禁用）', selfDel.disabled === true);

    /* 删除他人：确认后连台账一起清掉 */
    const lisiRow = rows.filter(r => r.textContent.indexOf('lisi') >= 0)[0];
    click(w, lisiRow.querySelector('[data-ua="del"]'));
    check('删除用户弹出确认框', id('maskConfirm').classList.contains('on'));
    click(w, id('cfOk'));
    await tick(40);
    check('用户已删除', usersOf(w).length === 3 && !usersOf(w).some(u => u.username === 'lisi'),
      usersOf(w).map(u => u.username).join(','));
    check('被删用户的台账已清除', !w.__SRV__.ledgers['lisi']
      && w.localStorage.getItem(dataKey('lisi')) === null);
    w.close();
  }

  /* ================= 7. 最后一个超管保护 ================= */
  {
    const fx = { version: 1, users: [
      mkUser({ username: 'admin', name: '唯一超管', role: 'admin', password: 'admin888' })
    ] };
    const dom = makeDom({ fixture: fx, sessionUser: 'admin', errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);
    click(w, id('userChip'));
    click(w, id('umUsers'));
    const row = d.querySelector('#usersTableWrap tbody tr');
    check('唯一超管的「停用」被禁用', row.querySelector('[data-ua="toggle"]').disabled === true);
    check('唯一超管的「删除」被禁用', row.querySelector('[data-ua="del"]').disabled === true);

    /* 降级保护 */
    click(w, row.querySelector('[data-ua="edit"]'));
    id('uRole').value = 'user';
    click(w, id('btnSaveUser'));
    check('唯一超管不能被降级', usersOf(w)[0].role === 'admin');
    check('降级被拒时给出说明', id('toast').textContent.indexOf('超级管理员') >= 0, id('toast').textContent);
    w.close();
  }

  /* ================= 8. 重置密码 / 修改自己的密码 ================= */
  {
    const dom = makeDom({ sessionUser: 'admin', data: { admin: mkDB(1, 'A-') }, errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    /* 超管重置 demo 的密码 */
    click(w, id('userChip'));
    click(w, id('umUsers'));
    const demoRow = [...d.querySelectorAll('#usersTableWrap tbody tr')]
      .filter(r => r.textContent.indexOf('demo') >= 0)[0];
    click(w, demoRow.querySelector('[data-ua="pwd"]'));
    check('重置密码弹窗打开', id('maskPwd').classList.contains('on'));
    check('重置他人密码时不要求原密码', id('pwdOldField').style.display === 'none');
    id('pwdNew').value = 'newpass888';
    id('pwdNew2').value = 'mismatch';
    click(w, id('btnSavePwd'));
    check('两次新密码不一致被拒绝', id('maskPwd').classList.contains('on')
      && id('toast').textContent.indexOf('不一致') >= 0, id('toast').textContent);
    id('pwdNew2').value = 'newpass888';
    click(w, id('btnSavePwd'));
    await tick(40);
    check('重置密码成功', !id('maskPwd').classList.contains('on'));

    /* 修改自己的密码：原密码校验 */
    click(w, id('userChip'));
    click(w, id('umPwd'));
    check('修改自己的密码要求输入当前密码', id('pwdOldField').style.display === 'block');
    id('pwdOld').value = 'wrong-old';
    id('pwdNew').value = 'adminNew888';
    id('pwdNew2').value = 'adminNew888';
    click(w, id('btnSavePwd'));
    await tick(40);   /* 改密走 /api/auth/password，异步返回 */
    check('当前密码错误时拒绝修改', id('maskPwd').classList.contains('on')
      && id('toast').textContent.indexOf('当前密码不正确') >= 0, id('toast').textContent);
    id('pwdOld').value = 'admin888';
    click(w, id('btnSavePwd'));
    await tick(40);
    check('修改自己的密码成功', !id('maskPwd').classList.contains('on'));

    /* 重置行为校验：注册表中的哈希应等价于新密码（同一 DOM 内比对） */
    const reg = usersOf(w);
    const demoRec = reg.filter(u => u.username === 'demo')[0];
    check('重置后 demo 的密码哈希与新密码一致',
      demoRec.pwd === hashPwd('newpass888', demoRec.salt));
    check('重置后 demo 的旧密码哈希不再匹配',
      demoRec.pwd !== hashPwd('demo888', demoRec.salt));
    const adminRec = reg.filter(u => u.username === 'admin')[0];
    check('改密后超管的新密码哈希一致', adminRec.pwd === hashPwd('adminNew888', adminRec.salt));
    check('改密后超管旧密码不再匹配', adminRec.pwd !== hashPwd('admin888', adminRec.salt));

    /* 端到端验证：退出后用新密码重新登录 */
    click(w, id('userChip'));
    click(w, id('umLogout'));
    await tick(30);
    id('loginUser').value = 'admin';
    id('loginPwd').value = 'admin888';
    submit(w, id('loginForm'));
    await tick(40);
    check('改密后旧密码无法登录', id('authView').classList.contains('on')
      && id('authErr').textContent.indexOf('不正确') >= 0, id('authErr').textContent);
    id('loginUser').value = 'admin';
    id('loginPwd').value = 'adminNew888';
    submit(w, id('loginForm'));
    await tick(60);
    check('改密后新密码可以登录', !id('authView').classList.contains('on'));
    click(w, id('userChip'));
    click(w, id('umLogout'));
    await tick(30);
    id('loginUser').value = 'demo';
    id('loginPwd').value = 'newpass888';
    submit(w, id('loginForm'));
    await tick(60);
    check('被重置密码的账号可用新密码登录', !id('authView').classList.contains('on'));
    w.close();
  }

  /* ================= 8.5 普通用户：数据日志入口 ================= */
  {
    const dom = makeDom({
      fixture: { version: 1, users: [
        mkUser({ username: 'admin', name: '超级管理员', role: 'admin', password: 'admin888' }),
        mkUser({ username: 'zhangsan', name: '张三', password: 'zhang1234' }),
        Object.assign(mkUser({ username: 'wangwu', name: '王五', password: 'wangw888' }), { shareFrom: 'zhangsan' })
      ] },
      sessionUser: 'wangwu',
      data: { zhangsan: mkDB(3, 'Z-') },
      errors
    });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);

    /* wangwu 以自己账号写一次数据（dataOwner 解析到 zhangsan）→ 产生日志 */
    const zd = JSON.parse(JSON.stringify(w.__SRV__.ledgers['zhangsan']));
    zd.customers[0].phone = '13900000000';
    await w.fetch('/api/ledger', { method: 'PUT', body: JSON.stringify({ scope: 'wangwu', data: zd }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' } });
    await tick(20);

    click(w, id('userChip'));
    check('普通用户菜单显示「数据日志」入口', id('umLogs').style.display !== 'none',
      'display=' + id('umLogs').style.display);
    click(w, id('umLogs'));
    await tick(40);
    check('普通用户可打开数据日志页', id('logsView').classList.contains('on'));
    check('普通用户不显示数据范围切换', id('logsScopeWrap').style.display === 'none',
      'display=' + id('logsScopeWrap').style.display);
    check('返回按钮指向看板', id('btnLogsBack').textContent.indexOf('返回看板') >= 0,
      id('btnLogsBack').textContent);
    check('日志归属解析到共享数据集（zhangsan）', id('logsSub').textContent.indexOf('zhangsan') >= 0,
      id('logsSub').textContent);
    check('能读到该数据集的变更记录（含操作人 wangwu）',
      d.querySelectorAll('#logsTableWrap tbody tr').length >= 1
      && id('logsTableWrap').textContent.indexOf('wangwu') >= 0,
      d.querySelectorAll('#logsTableWrap tbody tr').length + ' 行');
    click(w, id('btnLogsBack'));
    await tick(20);
    check('普通用户返回后直接回看板（不进用户管理）',
      !id('logsView').classList.contains('on') && !id('usersView').classList.contains('on'));
    w.close();
  }

  /* ================= 9. 退出登录 ================= */
  {
    const dom = makeDom({ sessionUser: 'demo', errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);
    click(w, id('userChip'));
    click(w, id('umLogout'));
    check('退出登录后回到登录页', id('authView').classList.contains('on'));
    check('退出后会话已清除', !w.localStorage.getItem('inspection_board_token_v1')
      && !w.localStorage.getItem('inspection_board_session_v1')
      && !w.sessionStorage.getItem('inspection_board_session_v1'));
    check('退出后看板数据已清空', id('stTotal').textContent === '0', id('stTotal').textContent);
    w.close();
  }

  /* ================= 10. 密码可见性切换 ================= */
  {
    const dom = makeDom({ sessionUser: null, errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);
    const eye = d.querySelector('.pwd-eye[data-eye="loginPwd"]');
    const inp = id('loginPwd');
    check('登录密码框带有查看按钮', !!eye);
    check('默认为密文且按钮未激活',
      inp.getAttribute('type') === 'password' && eye.getAttribute('aria-pressed') === 'false');
    click(w, eye);
    check('点击后显示当前密码（type=text）', inp.getAttribute('type') === 'text');
    check('按钮状态与无障碍标签同步', eye.getAttribute('aria-pressed') === 'true'
      && eye.getAttribute('aria-label') === '隐藏密码');
    click(w, eye);
    check('再次点击恢复密文', inp.getAttribute('type') === 'password'
      && eye.getAttribute('aria-pressed') === 'false');
    click(w, id('btnLogin'));
    /* 填好可用凭据后再点按钮：若按钮触发了提交，这里会直接登录成功 */
    id('loginUser').value = 'demo';
    id('loginPwd').value = 'demo888';
    click(w, eye);
    await tick(80);
    check('查看按钮不触发表单提交', id('authView').classList.contains('on')
      && !w.localStorage.getItem('inspection_board_token_v1'));
    w.close();
  }

  /* ================= 11. 改密弹窗的可见性切换 ================= */
  {
    const dom = makeDom({ sessionUser: 'demo', errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);
    click(w, id('userChip'));
    click(w, id('umPwd'));
    await tick(40);
    const eye = d.querySelector('.pwd-eye[data-eye="pwdNew"]');
    check('改密弹窗的新密码框带有查看按钮', !!eye);
    click(w, eye);
    check('改密弹窗内可显示新密码', id('pwdNew').getAttribute('type') === 'text');
    click(w, d.querySelector('#maskPwd [data-close="maskPwd"]'));
    await tick(20);
    click(w, id('userChip'));
    click(w, id('umPwd'));
    await tick(40);
    check('重新打开弹窗时恢复为隐藏', id('pwdNew').getAttribute('type') === 'password'
      && eye.getAttribute('aria-pressed') === 'false');
    w.close();
  }

  /* ================= 12. 用户管理：列排序 / 复制配置 / 用户名加粗 ================= */
  {
    const fx = { version: 1, users: [
      mkUser({ username: 'admin', name: '管理员', role: 'admin', password: 'admin888' }),
      mkUser({ username: 'bb', name: '陈二', password: 'bb88888' }),
      mkUser({ username: 'aa', name: '白一', password: 'aa88888' })
    ] };
    const dom = makeDom({ fixture: fx, sessionUser: 'admin', data: { admin: mkDB(1, 'A-') }, errors });
    const w = dom.window, d = w.document;
    await tick(260);
    const id = x => idOf(d, x);
    click(w, id('userChip'));
    click(w, id('umUsers'));
    await tick(20);
    /* 展示：主行 = 加粗的用户名，副行 = 显示名称；头像取用户名首字母
       （jsdom 取不到 inline style，加粗用 HTML 字符串断言；用户名取主行首个文本节点） */
    const cellOf = r => r.querySelector('.uname-cell');
    const mainOf = r => cellOf(r).querySelector('div > div > div');  /* 包裹div > 加粗div */
    const userOfRow = r => {
      const m = mainOf(r);
      return m ? m.textContent.replace('当前登录', '').trim() : '';
    };
    const rowsNow = () => [...d.querySelectorAll('#usersTableWrap tbody tr')];

    const firstCell = cellOf(rowsNow()[0]);
    check('主行以登录用户名展示且加粗',
      mainOf(rowsNow()[0]).textContent.trim() === 'aa' &&
      mainOf(rowsNow()[0]).outerHTML.indexOf('font-weight:600') >= 0,
      firstCell.innerHTML.slice(0, 60));
    check('显示名称退为副行（不加粗）', firstCell.querySelector('.sub2').textContent.indexOf('白一') === 0,
      firstCell.querySelector('.sub2').textContent.slice(0, 20));
    const aaRow = rowsNow().filter(r => userOfRow(r) === 'aa')[0];
    check('头像取用户名首字母', !!aaRow && aaRow.querySelector('.uavatar').textContent === 'a',
      aaRow && aaRow.querySelector('.uavatar').textContent);

    /* 列排序：默认显示名称升序，点表头切换升降序 */
    const orderNow = () => rowsNow().map(userOfRow).join(',');
    check('默认按显示名称升序（白一 < 陈二 < 管理员）', orderNow() === 'aa,bb,admin', orderNow());
    const nameTh = d.querySelector('#usersTableWrap th[data-ukey="name"]');
    check('表头带排序标识', !!nameTh && !!nameTh.querySelector('.sort-ind.on'), nameTh && nameTh.textContent);
    click(w, nameTh);
    check('再点同一列切换为降序', orderNow() === 'admin,bb,aa', orderNow());
    click(w, d.querySelector('#usersTableWrap th[data-ukey="role"]'));
    check('切换到角色列（超管在前）', orderNow() === 'admin,aa,bb', orderNow());
    click(w, d.querySelector('#usersTableWrap th[data-ukey="role"]'));
    check('角色列再点反转（超管在后）', orderNow() === 'aa,bb,admin', orderNow());

    /* 复制配置：预填全部配置，仅需手填用户名 */
    const bbRow = rowsNow().filter(r => userOfRow(r) === 'bb')[0];
    click(w, bbRow.querySelector('[data-ua="clone"]'));
    check('复制配置打开新建用户弹窗', id('maskUser').classList.contains('on'));
    check('弹窗标题标注复制来源', id('userModalTitle').textContent.indexOf('陈二') >= 0,
      id('userModalTitle').textContent);
    check('用户名留空待手填', id('uUsername').value === '' && !id('uUsername').disabled);
    check('显示名称 / 权限已预填', id('uName').value === '陈二' && id('uPerm').value === 'rw');
    check('初始数据已选「共享现有用户」且来源为被复制者',
      id('uSeed').value === 'copy' && id('uSeedUser').value === 'bb',
      id('uSeed').value + ' / ' + id('uSeedUser').value);
    id('uUsername').value = 'cc01';
    id('uPwd').value = 'cc88888';
    click(w, id('btnSaveUser'));
    await tick(60);
    check('复制配置后仅手填用户名即可创建', usersOf(w).some(u => u.username === 'cc01'));
    const cc = usersOf(w).filter(u => u.username === 'cc01')[0];
    check('新用户继承数据共享（shareFrom = bb）', cc && (cc.shareFrom || '') === 'bb',
      JSON.stringify(cc && cc.shareFrom));
    check('创建成功后弹窗关闭', !id('maskUser').classList.contains('on'));
    w.close();
  }

  /* ================= 汇总 ================= */
  const pass = results.filter(r => r[0] === 'PASS').length;
  results.forEach(r => console.log(r[0].padEnd(5) + ' ' + r[1] + (r[2] && r[0] === 'FAIL' ? '   => ' + r[2] : '')));
  console.log('--------------------------------');
  console.log('通过 ' + pass + ' / 共 ' + results.length + '，失败 ' + (results.length - pass));
  if (errors.length) {
    console.log('运行期错误:');
    errors.forEach(x => console.log('  ' + x));
  } else {
    console.log('运行期错误: 无');
  }
  process.exit(pass === results.length && !errors.length ? 0 : 1);
})();
