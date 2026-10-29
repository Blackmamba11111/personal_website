/* ============================================================================
 * test-custs.js —— 「客户管理」菜单页专项回归
 * 覆盖：入口/列表/表头字段（不含巡检数据）/搜索/新增/编辑/删除/只读守卫
 *       以及超管「数据范围」切换后的列表联动。
 * ==========================================================================*/
const { makeDom, dataKey, SCOPE_ALL, tick, html } = require('./test-helpers-server');

const errors = [];
const results = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }

const seedCustomers = [
  { id: 'c01', name: '农行北京数据中心', regionId: 'r-bj', province: '北京', city: '海淀区', addr: '北京市海淀区中关村南大街甲18号', lng: 116.31286, lat: 39.97654, freq: 'y12', contact: '王经理', phone: '', note: '' },
  { id: 'c02', name: '衡水银行总行', regionId: 'r-hb', province: '河北', city: '衡水', addr: '河北省衡水市桃城区人民东路528号', lng: 115.670186, lat: 37.73876, freq: 'quarter', contact: '张主管', phone: '0318-1234567', note: '总行机房' }
];
const seedRegions = [
  { id: 'r-bj', name: '北京', color: '#0891B2', provinces: ['北京'] },
  { id: 'r-hb', name: '河北', color: '#2563EB', provinces: ['河北'] }
];

(async () => {
  /* ================= 一、普通用户（demo）================= */
  const dom = makeDom({ errors });
  const w = dom.window, d = w.document;
  const id = x => d.getElementById(x);
  const click = el => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const fire = (el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true }));
  const store = () => JSON.parse(w.localStorage.getItem(dataKey('demo')));
  const rows = () => {
    const t = id('custsTableWrap').querySelector('table.custs tbody');
    return t ? t.querySelectorAll('tr') : [];
  };

  await tick(60);

  /* ---------- 1. 入口与列表 ---------- */
  check('看板工具栏存在「客户管理」入口', !!id('btnCusts'));
  click(id('btnCusts'));
  check('客户管理页已打开', id('custsView').classList.contains('on'));
  check('列表渲染为表格', !!id('custsTableWrap').querySelector('table.custs'));
  check('初始列表行数 = 14（示例数据）', rows().length === 14, rows().length + '');

  const head = id('custsTableWrap').querySelector('thead').textContent;
  ['客户名称', '所属区域', '省市', '详细地址', '联系人', '电话', '坐标', '频率要求', '操作']
    .forEach(k => check('表头含「' + k + '」', head.indexOf(k) >= 0));
  check('表头不含巡检相关字段', !/巡检|达标|季度目标|已巡检|最近/.test(head), head);
  check('副标题显示账号与客户数', /客户 14 家/.test(id('custsSub').textContent), id('custsSub').textContent);
  check('普通用户不显示数据范围下拉', id('custsScopeWrap').style.display === 'none');
  check('普通用户无「所属账号」列', head.indexOf('所属账号') < 0);

  /* ---------- 2. 搜索（查） ---------- */
  id('custsSearch').value = '衡水';
  fire(id('custsSearch'), 'input');
  check('搜索「衡水」命中 2 家', rows().length === 2, rows().length + '');
  id('custsSearch').value = '0318';   /* 命中电话，验证多字段检索 */
  fire(id('custsSearch'), 'input');
  check('搜索电话片段命中 1 家', rows().length === 1, rows().length + '');
  id('custsSearch').value = '不存在的客户zzz';
  fire(id('custsSearch'), 'input');
  check('无结果时显示空态文案', /没有符合搜索条件/.test(id('custsTableWrap').textContent));
  id('custsSearch').value = '';
  fire(id('custsSearch'), 'input');
  check('清空搜索恢复 14 家', rows().length === 14, rows().length + '');

  /* ---------- 3. 新增（增） ---------- */
  click(id('btnCustsAdd'));
  check('新增点击后打开客户表单', id('maskCust').classList.contains('on'));
  check('表单标题为「新增客户」', /新增客户/.test(id('custTitle').textContent), id('custTitle').textContent);
  id('fName').value = '测试客户A';
  id('fAddr').value = '河北省衡水市测试路1号';
  id('fLng').value = '115.610000';
  id('fLat').value = '37.720000';
  id('fContact').value = '李工';
  click(id('btnSaveCust'));
  check('保存后表单关闭', !id('maskCust').classList.contains('on'));
  check('台账客户数 = 15', store().customers.length === 15, store().customers.length + '');
  check('新客户已入本地镜像', !!store().customers.filter(c => c.name === '测试客户A')[0]);
  check('列表已刷新为 15 行', rows().length === 15, rows().length + '');
  const added = store().customers.filter(c => c.name === '测试客户A')[0];
  check('新客户为独立 id（不覆盖既有）', !!added && ['c01', 'c02'].indexOf(added.id) < 0, added && added.id);

  /* 校验：名称必填 / 坐标必填 */
  click(id('btnCustsAdd'));
  id('fName').value = '';
  click(id('btnSaveCust'));
  check('名称为空时拦截保存', id('maskCust').classList.contains('on') && store().customers.length === 15);
  click(d.querySelector('#maskCust [data-close]'));
  check('取消后表单关闭', !id('maskCust').classList.contains('on'));

  /* ---------- 3.1 层叠守卫：页面内的弹窗必须浮在内容页之上 ----------
     历史缺陷：客户抽屉(100) / 删除确认框(100) 被客户管理页（.page，150，整屏不透明）盖住，
     表现为「点了没反应，退出页面后才看到弹窗」。 */
  {
    const css = Array.from(d.querySelectorAll('style')).map(s => s.textContent).join('\n');
    const pageRule = /\.page\{[^}]*z-index:(\d+)/.exec(css);
    const highRule = /\.mask\.high,\.drawer-mask\.high\{[^}]*z-index:(\d+)/.exec(css);
    check('内容页层级声明存在', !!pageRule, pageRule && pageRule[1]);
    check('弹窗 high 层级高于内容页', !!highRule && !!pageRule && +highRule[1] > +pageRule[1],
      (highRule && highRule[1]) + ' vs ' + (pageRule && pageRule[1]));
    check('客户抽屉带 high 标记（不被客户管理页盖住）', id('maskCust').classList.contains('high'));
    check('删除确认框带 high 标记（不被客户管理页盖住）', id('maskConfirm').classList.contains('high'));
  }

  /* ---------- 3.2 城市候选覆盖：34 个省级行政区都要有城市 ---------- */
  {
    const provSel = id('fProvince'), citySel = id('fCity');
    const counts = {}, empty = [];
    Array.from(provSel.options).map(o => o.value).forEach(p => {
      provSel.value = p;
      fire(provSel, 'change');
      const n = Array.from(citySel.options).filter(o => o.value !== '__custom').length;
      counts[p] = n;
      if (!n) empty.push(p);
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    check('34 个省级行政区全部有城市候选', empty.length === 0, empty.join(' ') || '无缺失');
    check('城市候选条目总数 ≥ 400', total >= 400, total + '');
    check('上海为市辖区候选（≥16 项）', counts['上海'] >= 16, counts['上海'] + '');
    check('广东为地级市候选（≥21 项）', counts['广东'] >= 21, counts['广东'] + '');
    check('中国台湾有县市候选（≥18 项）', counts['中国台湾'] >= 18, counts['中国台湾'] + '');
    check('切换省份后城市列表随之变化', counts['北京'] !== counts['新疆'],
      counts['北京'] + ' vs ' + counts['新疆']);
    provSel.value = '江苏';
    fire(provSel, 'change');
    citySel.value = '南京';
    fire(citySel, 'change');
    check('选择城市自动带入坐标', Math.abs(parseFloat(id('fLng').value) - 118.78) < 0.25,
      id('fLng').value + ',' + id('fLat').value);
    check('回填逻辑保留不在候选内的历史城市名', /（当前值）/.test(html) && /insertAdjacentHTML/.test(html));
  }

  /* ---------- 4. 编辑（改） ---------- */
  id('custsSearch').value = '测试客户A';
  fire(id('custsSearch'), 'input');
  const editBtn = id('custsTableWrap').querySelector('button[data-cact="edit"]');
  check('行内「编辑」按钮存在', !!editBtn);
  click(editBtn);
  check('编辑打开表单', id('maskCust').classList.contains('on'));
  check('表单标题为「编辑客户资料」', /编辑客户资料/.test(id('custTitle').textContent), id('custTitle').textContent);
  check('表单回填原名称', id('fName').value === '测试客户A', id('fName').value);
  id('fName').value = '测试客户A（改名）';
  id('fContact').value = '王工';
  click(id('btnSaveCust'));
  check('编辑不新增记录（仍 15 家）', store().customers.length === 15, store().customers.length + '');
  check('改名已落库', !!store().customers.filter(c => c.name === '测试客户A（改名）')[0]);
  check('旧名已不存在', !store().customers.filter(c => c.name === '测试客户A')[0]);
  check('联系人已更新', store().customers.filter(c => c.name === '测试客户A（改名）')[0].contact === '王工');
  check('列表跟随搜索词刷新', rows().length === 1, rows().length + '');

  /* ---------- 5. 删除（删） ---------- */
  click(id('custsTableWrap').querySelector('button[data-cact="del"]'));
  check('删除弹出确认框', id('maskConfirm').classList.contains('on'));
  check('确认框提示同时清理巡检记录', /巡检记录/.test(id('cfMsg').textContent), id('cfMsg').textContent);
  click(id('cfCancel'));
  check('取消删除不生效（仍 15 家）', store().customers.length === 15, store().customers.length + '');
  click(id('custsTableWrap').querySelector('button[data-cact="del"]'));
  click(id('cfOk'));
  check('确认删除后客户数 = 14', store().customers.length === 14, store().customers.length + '');
  check('被删客户已从台账移除', !store().customers.filter(c => c.name === '测试客户A（改名）')[0]);
  id('custsSearch').value = '';
  fire(id('custsSearch'), 'input');
  check('清空搜索后恢复 14 家', rows().length === 14, rows().length + '');

  /* ---------- 6. 写操作已推送服务端（防抖 800ms） ---------- */
  await new Promise(r => setTimeout(r, 1100));
  const srvDemo = w.__SRV__ && w.__SRV__.ledgers && w.__SRV__.ledgers.demo;
  check('改动已推送到服务端台账', !!srvDemo && srvDemo.customers.length === 14,
    srvDemo ? srvDemo.customers.length + '' : '无服务端数据');

  /* ---------- 7. 返回看板 ---------- */
  click(id('btnCustsBack'));
  check('返回后客户管理页关闭', !id('custsView').classList.contains('on'));

  w.close();

  /* ================= 二、超级管理员（汇总只读 + 范围联动）================= */
  const dom2 = makeDom({
    errors,
    sessionUser: 'admin',
    data: {
      demo: { regions: seedRegions, customers: seedCustomers, visits: [] },
      admin: { regions: [], customers: [{ id: 'a01', name: '超管自建客户', regionId: '', province: '北京', city: '', addr: '', lng: 116.4, lat: 39.9, freq: 'y4', contact: '', phone: '', note: '' }], visits: [] }
    }
  });
  const w2 = dom2.window, d2 = w2.document;
  const id2 = x => d2.getElementById(x);
  const click2 = el => el && el.dispatchEvent(new w2.MouseEvent('click', { bubbles: true, cancelable: true }));
  const fire2 = (el, t) => el.dispatchEvent(new w2.Event(t, { bubbles: true }));
  const rows2 = () => id2('custsTableWrap').querySelectorAll('table.custs tbody tr');

  await tick(60);
  click2(id2('btnCusts'));
  check('[超管] 客户管理页已打开', id2('custsView').classList.contains('on'));
  check('[超管] 汇总视图显示数据范围下拉', id2('custsScopeWrap').style.display !== 'none');
  check('[超管] 汇总视图含「所属账号」列', id2('custsTableWrap').querySelector('thead').textContent.indexOf('所属账号') >= 0);
  check('[超管] 汇总视图跨账号列全部客户（1 + 2 = 3）', rows2().length === 3, rows2().length + '');
  check('[超管] 汇总视图展示所属账号标签', id2('custsTableWrap').querySelectorAll('tbody .own').length === 3);
  check('[超管] 汇总视图为只读（操作按钮禁用）',
    id2('custsTableWrap').querySelectorAll('button[data-cact][disabled]').length === 6,
    id2('custsTableWrap').querySelectorAll('button[data-cact][disabled]').length + '');
  check('[超管] 只读提示已展示', /只读/.test(id2('custsHint').textContent), id2('custsHint').textContent);

  /* 只读守卫：汇总视图点新增应被拦下 */
  click2(id2('btnCustsAdd'));
  check('[超管] 汇总视图点「新增客户」被拦下', !id2('maskCust').classList.contains('on'));

  /* 切换到具体账号 → 可编辑 */
  id2('custsScope').value = 'demo';
  fire2(id2('custsScope'), 'change');
  check('[超管] 切到 demo 后列表刷新为 2 家', rows2().length === 2, rows2().length + '');
  check('[超管] 切到 demo 后隐藏「所属账号」列', id2('custsTableWrap').querySelector('thead').textContent.indexOf('所属账号') < 0);
  check('[超管] 切到 demo 后操作按钮可用',
    id2('custsTableWrap').querySelectorAll('button[data-cact][disabled]').length === 0);
  check('[超管] 切到 demo 后只读提示清空', id2('custsHint').textContent === '');

  click2(id2('btnCustsAdd'));
  check('[超管] 具体账号下可打开新增表单', id2('maskCust').classList.contains('on'));
  id2('fName').value = '超管代录客户';
  id2('fLng').value = '115.670000';
  id2('fLat').value = '37.730000';
  click2(id2('btnSaveCust'));
  await new Promise(r => setTimeout(r, 1100));   /* 等防抖推送（800ms）落到「服务端」 */
  const srvDemo2 = w2.__SRV__.ledgers.demo;
  check('[超管] 代录写入目标账号（demo）台账', srvDemo2.customers.length === 3, srvDemo2.customers.length + '');

  /* 切回汇总视图 → 新客户出现在汇总列表 */
  id2('custsScope').value = SCOPE_ALL;
  fire2(id2('custsScope'), 'change');
  check('[超管] 切回汇总后总数为 1 + 3 = 4', rows2().length === 4, rows2().length + '');
  check('[超管] 汇总视图重新变为只读',
    id2('custsTableWrap').querySelectorAll('button[data-cact][disabled]').length === 8,
    id2('custsTableWrap').querySelectorAll('button[data-cact][disabled]').length + '');

  w2.close();

  /* ================= 三、列排序 / 批量添加 / 批量删除（勾选）================= */
  const dom3 = makeDom({
    errors,
    sessionUser: 'demo',
    data: {
      demo: {
        regions: seedRegions,
        customers: [
          { id: 'k1', name: '阿里巴巴', regionId: 'r-hb', province: '河北', city: '石家庄', addr: '', lng: 114.5, lat: 38.0, freq: 'y4', contact: '', phone: '', note: '' },
          { id: 'k2', name: '北京分行', regionId: 'r-bj', province: '北京', city: '海淀', addr: '', lng: 116.3, lat: 39.9, freq: 'y4', contact: '', phone: '', note: '' },
          { id: 'k3', name: '衡水银行', regionId: 'r-hb', province: '河北', city: '衡水', addr: '', lng: 115.7, lat: 37.7, freq: 'y4', contact: '', phone: '', note: '' }
        ],
        visits: []
      }
    }
  });
  const w3 = dom3.window, d3 = w3.document;
  const id3 = x => d3.getElementById(x);
  const click3 = el => el && el.dispatchEvent(new w3.MouseEvent('click', { bubbles: true, cancelable: true }));
  const fire3 = (el, t) => el.dispatchEvent(new w3.Event(t, { bubbles: true }));
  const store3 = () => JSON.parse(w3.localStorage.getItem(dataKey('demo')));
  const rows3 = () => id3('custsTableWrap').querySelectorAll('table.custs tbody tr');
  const names3 = () => [...rows3()].map(r => r.querySelectorAll('td')[1].textContent.trim());
  const chks3 = () => [...id3('custsTableWrap').querySelectorAll('input[data-chkid]')];

  await tick(60);
  click3(id3('btnCusts'));
  check('测试页已打开（3 家客户）', rows3().length === 3, rows3().length + '');

  /* 列排序：客户名称 / 所属区域 / 省市 */
  check('默认按客户名称升序', names3().join(',') === '阿里巴巴,北京分行,衡水银行', names3().join(','));
  click3(id3('custsTableWrap').querySelector('th[data-ckey="region"]'));
  check('按所属区域排序（北京组在前）', names3().join(',') === '北京分行,阿里巴巴,衡水银行', names3().join(','));
  click3(id3('custsTableWrap').querySelector('th[data-ckey="pc"]'));
  check('按省市排序（北京在前，同省按城市拼音）', names3().join(',') === '北京分行,衡水银行,阿里巴巴', names3().join(','));
  click3(id3('custsTableWrap').querySelector('th[data-ckey="name"]'));
  check('切到客户名称列先为升序', names3().join(',') === '阿里巴巴,北京分行,衡水银行', names3().join(','));
  click3(id3('custsTableWrap').querySelector('th[data-ckey="name"]'));
  check('客户名称列再点为降序', names3().join(',') === '衡水银行,北京分行,阿里巴巴', names3().join(','));

  /* 批量删除：勾选 → 确认 → 删除（含巡检记录级联） */
  check('未勾选时「删除选中」隐藏', id3('btnCustsBatchDel').style.display === 'none');
  click3(chks3()[0]);                                  /* 勾选第 1 行（阿里巴巴） */
  fire3(chks3()[0], 'change');
  check('勾选后显示删除按钮与数量', id3('btnCustsBatchDel').style.display !== 'none' &&
    id3('btnCustsBatchDel').textContent.indexOf('（1）') >= 0, id3('btnCustsBatchDel').textContent);
  click3(id3('custsSelAll'));
  fire3(id3('custsSelAll'), 'change');
  check('全选后 3 行复选框都勾上', chks3().every(cb => cb.checked) &&
    id3('btnCustsBatchDel').textContent.indexOf('（3）') >= 0, id3('btnCustsBatchDel').textContent);
  click3(id3('custsSelAll'));
  fire3(id3('custsSelAll'), 'change');
  check('取消全选后清空且按钮隐藏', chks3().every(cb => !cb.checked) &&
    id3('btnCustsBatchDel').style.display === 'none');
  chks3()[0].checked = true; fire3(chks3()[0], 'change');
  chks3()[2].checked = true; fire3(chks3()[2], 'change');   /* 勾选 阿里巴巴 + 衡水银行 */
  click3(id3('btnCustsBatchDel'));
  check('批量删除弹出确认框', id3('maskConfirm').classList.contains('on'));
  click3(id3('cfOk'));
  await tick(40);
  check('批量删除后剩 1 家（北京分行）', rows3().length === 1 && names3()[0] === '北京分行', names3().join(','));
  check('台账中同步删除 2 家', store3().customers.length === 1, store3().customers.length + '');
  check('删除后按钮隐藏且勾选清空', id3('btnCustsBatchDel').style.display === 'none');

  /* 批量添加：客户管理内「导入数据」菜单（CSV），重名跳过并在结果提示 */
  click3(id3('btnImport'));
  check('导入数据菜单已打开（客户管理内）', id3('maskImport').classList.contains('on'));
  id3('csvBox').value = [
    '客户名称,所属区域,所在省份,城市,详细地址,经度,纬度,频率,联系人,联系电话,备注',
    '北京分行,河北,河北,衡水,,115.7,37.7,y4,张三,0318-1111111,',
    '新客户甲,河北,河北,衡水,某路1号,,,y4,李四,13800000000,',
    '新客户乙,河北,河北,衡水,,,y4,,,'
  ].join('\n');
  click3(id3('btnDoImport'));
  await tick(40);
  check('CSV 导入后共 3 家（新增 2 家）', rows3().length === 3, rows3().length + '');
  check('重名客户未被复制', store3().customers.filter(c => c.name === '北京分行').length === 1);
  const jia = store3().customers.filter(c => c.name === '新客户甲')[0];
  check('CSV 字段解析正确（地址/联系人/电话）', !!jia && jia.addr === '某路1号' &&
    jia.contact === '李四' && jia.phone === '13800000000', JSON.stringify(jia));
  check('导入结果提示跳过重名', id3('toast').textContent.indexOf('跳过已存在') >= 0, id3('toast').textContent);
  check('导入后菜单已关闭', !id3('maskImport').classList.contains('on'));

  /* 名称唯一：CSV 全部重名 → 不导入并提示；单个新增重名 → 提示已存在 */
  click3(id3('btnImport'));
  id3('csvBox').value = '客户名称,所属区域,所在省份,城市,详细地址,经度,纬度,频率,联系人,联系电话,备注\n新客户甲,河北,河北,衡水,,,y4,,,';
  click3(id3('btnDoImport'));
  check('CSV 全部重名时提示已存在且不导入', id3('toast').textContent.indexOf('已存在') >= 0 &&
    id3('maskImport').classList.contains('on') && rows3().length === 3, id3('toast').textContent);
  click3(d3.querySelector('#maskImport [data-close="maskImport"]'));
  await tick(20);
  click3(id3('btnCustsAdd'));
  id3('fName').value = '新客户甲';
  id3('fLng').value = '115.670000';
  id3('fLat').value = '37.730000';
  click3(id3('btnSaveCust'));
  check('单个新增重名被拒绝并提示', id3('toast').textContent.indexOf('已存在') >= 0 &&
    id3('maskCust').classList.contains('on') && store3().customers.length === 3, id3('toast').textContent);
  check('确认框提示含客户名称', id3('toast').textContent.indexOf('新客户甲') >= 0, id3('toast').textContent);
  w3.close();

  /* ================= 输出 ================= */
  const pass = results.filter(r => r[0] === 'PASS').length;
  results.forEach(r => console.log(r[0].padEnd(5) + ' ' + r[1] + (r[2] && r[0] === 'FAIL' ? '   => ' + r[2] : '')));
  console.log('--------------------------------');
  console.log('通过 ' + pass + ' / 共 ' + results.length + '，失败 ' + (results.length - pass));
  if (errors.length) { console.log('运行期错误:'); errors.forEach(x => console.log('  ' + x)); }
  else console.log('运行期错误: 无');
  process.exit(pass === results.length && !errors.length ? 0 : 1);
})();
