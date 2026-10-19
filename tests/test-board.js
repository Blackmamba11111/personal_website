/* 交互回归测试（含区域管理与地点搜索） */
const { makeDom, dataKey } = require('./test-helpers-server');

const errors = [];

const results = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }

/* 以普通用户 demo 身份登录，台账数据范围 = 自己的（regionId 未经前缀改写，便于断言） */
const dom = makeDom({ errors });
const w = dom.window, d = w.document;
const id = x => d.getElementById(x);
const click = el => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const fire = (el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true }));
const store = () => JSON.parse(w.localStorage.getItem(dataKey('demo')));

setTimeout(() => {
  // ============ 基础 ============
  check('客户数 = 14', id('stTotal').textContent === '14', id('stTotal').textContent);
  check('区域筛选 chips 已渲染', d.querySelectorAll('#regionChips .chip').length === 4,
    '实际 ' + d.querySelectorAll('#regionChips .chip').length + '（全部 + 3 区域）');
  check('列表按区域分组', d.querySelectorAll('#custList .group-title').length === 3,
    d.querySelectorAll('#custList .group-title').length + ' 组');
  check('分组标题带颜色圆点', d.querySelectorAll('#custList .rgdot').length === 3);
  check('数据含 regions', store().regions.length === 3, store().regions.length + ' 个区域');
  check('客户已绑定 regionId', store().customers.every(c => !!c.regionId));
  check('客户已绑定 province', store().customers.every(c => !!c.province));

  // ============ 区域筛选 ============
  const hbChip = d.querySelector('#regionChips .chip[data-rid="r-hb"]');
  click(hbChip);
  check('点击河北区域筛选生效', d.querySelectorAll('#custList .card-cust').length === 8,
    d.querySelectorAll('#custList .card-cust').length + ' 家');
  click(d.querySelector('#regionChips .chip[data-rid="all"]'));
  check('恢复全部区域', d.querySelectorAll('#custList .card-cust').length === 14);

  // ============ 区域设置 ============
  click(id('btnRegions'));
  check('区域设置弹窗打开', id('maskRegion').classList.contains('on'));
  check('区域行数 = 3', d.querySelectorAll('#regionList .rg-row').length === 3);
  check('省份可选标签已渲染', d.querySelectorAll('#regionList .rg-row:first-child .pchip').length === 34,
    d.querySelectorAll('#regionList .rg-row:first-child .pchip').length + ' 个省');

  // 新建区域
  click(id('btnAddRegion'));
  check('新建区域后行数 = 4', d.querySelectorAll('#regionList .rg-row').length === 4);
  check('新建区域写入存储', store().regions.length === 4, store().regions.length + '');

  // 命名为「东北区」并勾选 辽宁/吉林/黑龙江
  const rows = d.querySelectorAll('#regionList .rg-row');
  const newRow = rows[rows.length - 1];
  const nameInput = newRow.querySelector('.rg-name');
  nameInput.value = '东北区';
  fire(nameInput, 'input');
  ['辽宁', '吉林', '黑龙江'].forEach(pv => {
    const chip = newRow.querySelector('.pchip[data-prov="' + pv + '"]');
    click(chip);
  });
  const savedNew = store().regions.filter(r => r.name === '东北区')[0];
  check('区域重命名已保存', !!savedNew && savedNew.provinces.length === 3,
    savedNew ? savedNew.provinces.join('/') : '未找到');
  check('勾选省份后标签高亮', newRow.querySelectorAll('.pchip.on').length === 3,
    newRow.querySelectorAll('.pchip.on').length + '');

  // 颜色修改
  const colorInput = newRow.querySelector('.rg-color');
  colorInput.value = '#DB2777';
  fire(colorInput, 'input');
  check('区域颜色已保存', store().regions.filter(r => r.name === '东北区')[0].color === '#DB2777');

  click(d.querySelector('#maskRegion [data-close]'));
  check('区域弹窗可关闭', !id('maskRegion').classList.contains('on'));
  check('区域 chips 已同步新增', d.querySelectorAll('#regionChips .chip').length === 5,
    d.querySelectorAll('#regionChips .chip').length + ' 个');

  // 取消勾选一个省份
  click(id('btnRegions'));
  const rows2 = d.querySelectorAll('#regionList .rg-row');
  const row2 = rows2[rows2.length - 1];
  click(row2.querySelector('.pchip[data-prov="黑龙江"]'));
  check('取消勾选省份生效', store().regions.filter(r => r.name === '东北区')[0].provinces.length === 2);

  // 删除区域 → 自定义确认框
  click(row2.querySelector('[data-act="rgdel"]'));
  check('删除区域弹出自定义确认框', id('maskConfirm').classList.contains('on'));
  click(id('cfOk'));
  check('区域已删除', store().regions.length === 3, store().regions.length + '');
  click(d.querySelector('#maskRegion [data-close]'));

  // ============ 抽屉式客户表单 ============
  click(id('btnAdd'));
  check('客户表单以抽屉打开', id('maskCust').classList.contains('on')
    && id('maskCust').classList.contains('drawer-mask'));
  check('抽屉不遮挡地图（无背景遮罩）',
    w.getComputedStyle(id('maskCust')).pointerEvents === 'none');
  check('区域下拉已填充', id('fRegion').options.length === 3, id('fRegion').options.length + '');
  check('省份下拉已填充', id('fProvince').options.length === 34, id('fProvince').options.length + '');

  // 省份切换联动城市
  id('fProvince').value = '黑龙江';
  fire(id('fProvince'), 'change');
  check('切到黑龙江后城市选项更新', id('fCity').options.length >= 12,
    id('fCity').options.length + ' 项');
  check('城市下拉首项为哈尔滨', id('fCity').options[0].value === '哈尔滨', id('fCity').options[0].value);

  // 34 个省级行政区均有城市候选（回归：早期仅 7 个省带城市数据，其余省份城市列表为空）
  {
    const provs = Array.from(id('fProvince').options).map(o => o.value);
    const empty = [];
    provs.forEach(p => {
      id('fProvince').value = p;
      fire(id('fProvince'), 'change');
      const n = Array.from(id('fCity').options).filter(o => o.value !== '__custom').length;
      if (!n) empty.push(p);
    });
    check('34 个省级行政区全部有城市候选', empty.length === 0, empty.join(' ') || '无缺失');
  }

  // 区域与省份不匹配提示
  id('fProvince').value = '辽宁';
  fire(id('fProvince'), 'change');
  check('省份不在区域内时给出提示', id('placeHint').textContent.indexOf('尚未包含') >= 0,
    id('placeHint').textContent);

  // ============ 地点搜索（地图未加载时的降级） ============
  id('placeKw').value = '衡水银行总行';
  click(id('btnPlaceSearch'));
  check('地图未加载时地点搜索给出提示（不静默）',
    id('placeHint').textContent.indexOf('地图未加载') >= 0, id('placeHint').textContent);

  // ============ 保存客户 ============
  id('fName').value = '测试客户A';
  id('fProvince').value = '辽宁';
  fire(id('fProvince'), 'change');
  id('fName').value = '测试客户A';
  click(id('btnSaveCust'));
  check('保存后抽屉关闭', !id('maskCust').classList.contains('on'));
  check('客户数 +1 = 15', id('stTotal').textContent === '15', id('stTotal').textContent);
  const nc = store().customers.filter(c => c.name === '测试客户A')[0];
  check('新客户带 province/regionId', !!nc && nc.province === '辽宁' && !!nc.regionId,
    nc ? nc.province + '/' + nc.regionId : '未找到');

  // ============ 编辑客户：区域回填 ============
  click(d.querySelector('#custList .card-cust'));
  click(id('btnEditCust'));
  check('编辑时区域/省份正确回填',
    id('maskCust').classList.contains('on') && id('fName').value.length > 0 && id('fProvince').value.length > 0,
    id('fProvince').value);
  click(d.querySelector('#maskCust [data-close]'));
  check('关闭抽屉后候选点被清理', d.querySelectorAll('#candList .cand-item').length === 0);

  // ============ 客户详情与巡检 ============
  click(d.querySelector('#custList .card-cust'));
  check('客户详情打开', id('maskDetail').classList.contains('on'));
  check('详情副标题含区域与省份', id('dSub').textContent.indexOf('·') > 0, id('dSub').textContent);
  const before = store().visits.length;
  id('dVisitNote').value = '测试备注';
  click(id('btnAddVisit'));
  check('巡检记录写入', store().visits.length === before + 1);
  click(id('btnDelCust'));
  check('删除客户弹出自定义确认框', id('maskConfirm').classList.contains('on'));
  click(id('cfCancel'));

  // ============ 提醒窗口 ============
  click(id('btnRemind'));
  check('提醒窗口打开', id('maskRemind').classList.contains('on'));
  check('提醒项含区域与省份', d.querySelector('#rmList .r-meta').textContent.indexOf('·') > 0,
    d.querySelector('#rmList .r-meta').textContent.slice(0, 46));
  click(id('btnRemindExport'));
  check('导出兜底面板打开', id('maskExport').classList.contains('on'));
  check('待办清单含区域列', id('exBox').value.split('\n')[0].indexOf('所属区域') > 0);
  click(d.querySelector('#maskExport [data-close]'));

  // ============ 导出报表 ============
  click(id('btnImport'));
  click(id('btnExportCsv'));
  check('报表导出行含区域/省份列', id('exBox').value.split('\n')[0].indexOf('所属区域,所在省份') > 0,
    id('exBox').value.split('\n')[0].slice(0, 40));
  check('报表数据行数 = 15+1', id('exBox').value.split('\n').length === 16,
    id('exBox').value.split('\n').length + '');
  click(d.querySelector('#maskExport [data-close]'));

  // CSV 导入（新列序）
  id('csvBox').value = '测试支行B,河北,河北,衡水,测试路1号,115.700000,37.750000,y4,李工,备注内容';
  fire(id('csvBox'), 'input');
  click(id('btnDoImport'));
  check('CSV 导入成功', id('stTotal').textContent === '16', id('stTotal').textContent);
  const imp = store().customers.filter(c => c.name === '测试支行B')[0];
  check('导入客户区域/省份正确', !!imp && imp.province === '河北' && !!imp.regionId,
    imp ? imp.province + '/' + imp.regionId : '未找到');

  // ============ 恢复示例数据 ============
  click(id('btnImport'));
  click(id('btnResetDemo'));
  check('恢复示例数据确认框', id('maskConfirm').classList.contains('on'));
  click(id('cfOk'));
  check('恢复后客户数 = 14', id('stTotal').textContent === '14', id('stTotal').textContent);
  check('恢复后区域数 = 3', store().regions.length === 3, store().regions.length + '');

  // ============ 季度切换 ============
  id('quarterSel').value = '2026Q3';
  fire(id('quarterSel'), 'change');
  check('切到 2026Q3 统计刷新', id('stOk').textContent !== '0', '已巡检 ' + id('stOk').textContent);

  // ============ 输出 ============
  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL');
  results.forEach(r => console.log(r[0] + '  ' + r[1] + (r[2] ? '   [' + r[2] + ']' : '')));
  console.log('\n===== ' + pass + ' / ' + results.length + ' 通过 =====');
  if (fail.length) { console.log('失败项：'); fail.forEach(f => console.log('  - ' + f[1] + ' ' + f[2])); }
  if (errors.length) { console.log('\n运行期错误：'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('无运行期脚本错误');
  process.exit(fail.length ? 1 : 0);
}, 900);
