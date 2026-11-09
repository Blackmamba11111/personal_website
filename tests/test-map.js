/* ============================================================
   test-map.js —— 「地图已就绪」路径回归测试
   先用 TMap 桩让 mapReady 置位，再验证：
     · 省份轮廓以带洞结构（LatLng[][][]）送达地图 SDK
     · 标记层几何数量与当前数据范围一致
     · 切换数据范围 / 退出登录时图层正确重建、不抛错
   ============================================================ */
const { makeDom, mkUser, dataKey } = require('./test-helpers-server');
const { installTMap } = require('./tmap-stub');

const results = [];
const errors = [];
function check(l, c, e) { results.push([c ? 'PASS' : 'FAIL', l, e || '']); }
const tick = ms => new Promise(r => setTimeout(r, ms));
const idOf = (d, x) => d.getElementById(x);
const click = (w, el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const fire = (w, el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true, cancelable: true }));

/* 数据：含天津（带洞）与河北（多块飞地）的区域，用于验证带洞轮廓 */
const DATA = {
  regions: [
    { id: 'r-tj', name: '天津片区', color: '#7C3AED', provinces: ['天津'] },
    { id: 'r-hb', name: '河北片区', color: '#2563EB', provinces: ['河北'] }
  ],
  customers: [
    { id: 'c1', name: '天津客户', regionId: 'r-tj', province: '天津', city: '和平区', addr: '', lng: 117.2, lat: 39.12, freq: 'y4', contact: '', phone: '', note: '', hasCoords: true },
    { id: 'c2', name: '河北客户', regionId: 'r-hb', province: '河北', city: '衡水', addr: '', lng: 115.67, lat: 37.73, freq: 'y4', contact: '', phone: '', note: '', hasCoords: true }
  ],
  visits: []
};

const findLayer = (rec, geomKey) => rec.layers.filter(L => L.geometries.length && L.geometries[0] && geomKey(L.geometries[0]));

(async function main() {
  const dom = makeDom({
    sessionUser: 'admin',
    data: { admin: JSON.parse(JSON.stringify(DATA)), demo: JSON.parse(JSON.stringify(DATA)) },
    errors,
    installGlobals: installTMap
  });
  const w = dom.window, d = w.document;
  await tick(300);
  const id = x => idOf(d, x);
  const rec = () => w.__TMAP;
  /* 按「最新实例 + 仍挂在地图上」定位当前生效的图层，
     避免取到之前已 setMap(null) 的历史实例导致误判 */
  const lastLayer = (kind, pred) => rec().layers
    .filter(L => L.__kind === kind && L.map)
    .filter(pred || (() => true))
    .pop();
  const polyLayer = () => lastLayer('MultiPolygon');
  const markerLayer = () => lastLayer('MultiMarker', L => L.opts.styles && L.opts.styles.ok);

  check('TMap 桩生效：地图对象已创建', !!rec().map);
  check('地图容器 id 正确', rec().map && rec().map.id === 'map', rec().map && rec().map.id);
  check('地图未展示降级提示', !id('mapFail').classList.contains('on'));

  /* ---------- 与地图无关的 UI 仍正常 ---------- */
  await tick(20);

  /* ---------- 1. 区域轮廓为带洞结构 ---------- */
  let PL = polyLayer();
  check('区域多边形图层已构建', !!PL);
  if (PL) {
    /* 汇总视图同名区域跨账号合并，id 变为 'm::区域名' */
    const tj = PL.geometries.filter(g => g.id.indexOf('天津片区') >= 0)[0];
    const hb = PL.geometries.filter(g => g.id.indexOf('河北片区') >= 0)[0];
    check('天津以独立多边形送达地图', !!tj);
    if (tj) {
      check('天津轮廓为带洞结构（外环 + 1 洞环）', tj.paths.length === 1 && tj.paths[0].length === 2,
        'paths=' + tj.paths.length + ' rings=' + (tj.paths[0] ? tj.paths[0].length : '-'));
      check('洞环为 LatLng 数组且点数 > 3',
        Array.isArray(tj.paths[0][1]) && tj.paths[0][1].length > 3,
        tj.paths[0][1] ? tj.paths[0][1].length + ' 点' : '无');
      check('坐标字段为 LatLng(lat,lng) 顺序',
        typeof tj.paths[0][0][0].getLat === 'function'
        && Math.abs(tj.paths[0][0][0].getLat() - 39.0) < 2
        && Math.abs(tj.paths[0][0][0].getLng() - 117.4) < 2,
        tj.paths[0][0][0].getLat().toFixed(3) + ',' + tj.paths[0][0][0].getLng().toFixed(3));
    }
    if (hb) {
      check('河北以多块陆地送达地图（主体 + 飞地 + 岛屿）', hb.paths.length >= 2,
        hb.paths.length + ' 块');
      const hasHole = hb.paths.some(poly => poly.length > 1);
      check('河北各块均为 [外环, 洞环...] 结构', Array.isArray(hb.paths[0]) && Array.isArray(hb.paths[0][0]),
        '无洞环=' + !hasHole);
    }
  }

  /* ---------- 2. 标记数量与数据范围一致 ---------- */
  let ML = markerLayer();
  check('标记为 LatLng 位置对象',
    ML && typeof ML.geometries[0].position.getLat === 'function');
  check('汇总视图标记数 = 全部账号客户数（2 个账号 × 2 家 = 4）',
    ML && ML.geometries.length === 4, ML ? ML.geometries.length + '' : '无');

  /* ---------- 3. 切换到具体用户后图层重建 ---------- */
  const layersBefore = rec().layers.length;
  id('scopeSel').value = 'demo';
  fire(w, id('scopeSel'), 'change');
  await tick(40);
  check('切换数据范围未抛错', true);
  ML = markerLayer();
  check('切换后标记数 = 该用户客户数（2 家）', ML && ML.geometries.length === 2,
    ML ? ML.geometries.length + '' : '无');
  PL = polyLayer();
  check('切换后区域图层已重建（区域数 = 2）', PL && PL.geometries.length === 2,
    PL ? PL.geometries.length + '' : '无');
  check('切换过程中未泄漏旧图层引用（图层总数保持有界）',
    rec().layers.length <= layersBefore + 4, rec().layers.length + ' 个');

  /* ---------- 3.5 点击区域 / 全部区域：视野贴合客户坐标 ---------- */
  {
    /* jsdom 不做布局，容器尺寸为 0；显式给个可视区尺寸，走真实的反算分支 */
    const mapEl = id('map');
    Object.defineProperty(mapEl, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(mapEl, 'clientHeight', { configurable: true, value: 600 });
    const chipOf = rid => [].slice.call(d.querySelectorAll('#regionChips .chip'))
      .filter(b => b.getAttribute('data-rid') === rid)[0];
    check('区域 chip 已渲染（全部区域 + 天津片区）', !!chipOf('all') && !!chipOf('r-tj'));

    click(w, chipOf('r-tj'));
    await tick(20);
    const c1 = rec().map.center;
    check('单客户区域：中心落到该客户坐标',
      !!c1 && Math.abs(c1.getLng() - 117.2) < 0.01 && Math.abs(c1.getLat() - 39.12) < 0.01,
      c1 ? c1.getLng().toFixed(3) + ',' + c1.getLat().toFixed(3) : '无');
    check('单客户区域：限制在 12 级（避免糊成一片）', rec().map.zoom === 12, String(rec().map.zoom));

    click(w, chipOf('all'));
    await tick(20);
    const c2 = rec().map.center, zAll = rec().map.zoom;
    check('全部区域：中心为两家客户的中点（116.435, 38.425）',
      !!c2 && Math.abs(c2.getLng() - 116.435) < 0.01 && Math.abs(c2.getLat() - 38.425) < 0.01,
      c2 ? c2.getLng().toFixed(3) + ',' + c2.getLat().toFixed(3) : '无');
    check('全部区域：缩放按客户边界反算（≥7 且 <12）',
      zAll >= 7 && zAll < 12, zAll.toFixed(2) + ' 级');
  }

  /* ---------- 3.6 左侧点选客户：地图居中到该点（2026-11-09） ---------- */
  {
    const cards = [].slice.call(d.querySelectorAll('#custList .card-cust'));
    check('左侧客户卡片已渲染', cards.length > 0, String(cards.length));
    const card = cards[0];
    const cid = card.getAttribute('data-id');
    /* 先摆成「省级视野 + 中心在别处」，验证点选是强制居中而不只是「不在视野才动」 */
    rec().map.zoom = 7;
    rec().map.center = new w.TMap.LatLng(30, 100);
    click(w, card);
    await tick(20);
    const halo = rec().layers.filter(L => L.__kind === 'MultiCircle' && L.map && L.opts.styles && L.opts.styles.halo).pop();
    const g = halo && halo.geometries && halo.geometries[0];
    const mc = rec().map.center;
    check('点选后该客户有高亮环', !!g && !!g.center, g ? '有' : '无高亮环');
    check('点选后地图中心 = 该客户坐标',
      !!g && !!mc && Math.abs(mc.getLng() - g.center.getLng()) < 1e-6 && Math.abs(mc.getLat() - g.center.getLat()) < 1e-6,
      mc ? mc.getLng().toFixed(4) + ',' + mc.getLat().toFixed(4) : '无中心');
    check('点选后缩放拉到城区级（≥12）', rec().map.zoom >= 12, String(rec().map.zoom));
    /* 光晕是地图上的真实范围：固定 1.2km，交给地图按比例缩放（旧算法 12 级就是 265px，糊满半屏） */
    const mPerPx = zz => 156543.03392 * Math.cos(g.center.getLat() * Math.PI / 180) / Math.pow(2, zz);
    const px12 = g ? g.radius / mPerPx(12) : 0;
    check('光晕为固定地理半径 1.2km（12 级约 40px，与标记比例相称）',
      Math.abs(g.radius - 1200) < 1 && px12 > 34 && px12 < 48, px12.toFixed(1) + 'px / ' + Math.round(g.radius) + 'm');
    check('点选后卡片为选中态', !!(d.querySelector('#custList .card-cust.sel')), cid || '无');
    check('点选后详情弹窗打开', id('maskDetail').classList.contains('on'));

    /* 再放大到 16 级点一次：半径不变、屏幕尺寸按比例放大 —— 这才是「跟着地图比例缩放」 */
    rec().map.zoom = 16;
    const card2 = [].slice.call(d.querySelectorAll('#custList .card-cust'))
      .filter(el => el.getAttribute('data-id') === cid)[0];
    click(w, card2 || cards[0]);
    await tick(20);
    const halo2 = rec().layers.filter(L => L.__kind === 'MultiCircle' && L.map && L.opts.styles && L.opts.styles.halo).pop();
    const g2 = halo2 && halo2.geometries && halo2.geometries[0];
    const px16 = g2 ? g2.radius / mPerPx(16) : 0;
    check('放大到 16 级半径不变、屏幕尺寸随比例放大（不再固定像素）',
      !!g2 && Math.abs(g2.radius - g.radius) < 1e-6 && px16 > px12 * 10,
      px16 ? px12.toFixed(0) + 'px → ' + px16.toFixed(0) + 'px' : '无');
    check('光晕带描边（边缘收得住，不是一团色雾）',
      !!halo2 && halo2.opts.styles.halo.showBorder === true &&
      halo2.opts.styles.halo.borderWidth > 0, '');

    /* 关掉详情，恢复后续用例的环境（详情无改动时静默关闭） */
    click(w, id('maskDetail').querySelector('[data-close="maskDetail"]'));
    await tick(30);
    check('关闭详情后地图仍停在该客户（视野不回退）',
      !!mc && Math.abs(rec().map.center.getLng() - mc.getLng()) < 1e-6, '');
  }

  /* ---------- 4. 退出登录：不抛错且清空 ---------- */
  let threw = null;
  try {
    click(w, id('userChip'));
    click(w, id('umLogout'));
    await tick(40);
  } catch (e) { threw = e.message; }
  check('退出登录未抛错', !threw, threw || '');
  ML = markerLayer();
  check('退出后标记已清空', !ML || ML.geometries.length === 0,
    ML ? ML.geometries.length + '' : '无标记图层');
  PL = polyLayer();
  check('退出后区域图层已清空重建', !PL || PL.geometries.length === 0,
    PL ? PL.geometries.length + '' : '无多边形');
  check('退出后回到登录页', id('authView').classList.contains('on'));

  /* ---------- 5. 重新登录后图层恢复 ---------- */
  id('loginUser').value = 'demo';
  id('loginPwd').value = 'demo888';
  id('loginForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await tick(60);
  check('重新登录成功', !id('authView').classList.contains('on'));
  ML = markerLayer();
  check('重新登录后标记恢复（2 家）', ML && ML.geometries.length === 2,
    ML ? ML.geometries.length + '' : '无');
  check('重新登录未重复初始化地图（地图对象唯一）', rec().layers.filter(L => L.handlers.click).length >= 1);
  /* 回归：退出登录时 clearMapLayers 会把客户名称标签层置空，
     重登录后必须重建（否则名称标签永远不再出现） */
  const CLL = lastLayer('MultiLabel', L => L.opts.styles && L.opts.styles.nameOn);
  check('重新登录后客户名称标签层已重建', !!CLL, '无标签层');
  check('重建后名称标签几何数 = 客户数（2）',
    CLL && CLL.geometries.length === 2, CLL ? CLL.geometries.length + '' : '无');

  /* ================= N. 地图点选与地点搜索的防呆 ================= */
  {
    /* 页面源码级断言：这些路径依赖真实浏览器事件，jsdom 无法完整模拟 */
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'inspection-dashboard.html'), 'utf8');
    check('点选横幅层级高于弹窗遮罩（z-index≥340）',
      /\.pick-banner\{[^}]*z-index:(3[4-9]\d|[4-9]\d\d)/.test(src));
    check('进入点选模式会先收起季度提醒弹窗（避免遮罩吃掉地图点击）',
      /btnPick'\)\.onclick[\s\S]{0,400}maskRemind[\s\S]{0,120}classList\.remove\('on'\)/.test(src));
    check('地点搜索经服务端代理（绕开腾讯接口的 CORS 限制）',
      src.indexOf("wsApi('suggestion'") > 0
      && src.indexOf("wsApi('geocode'") > 0
      && src.indexOf("api('/place/search?type='") > 0);
    check('检索配额用尽（121）有明确提示', src.indexOf('今日调用额度已用尽') > 0);
    /* 回归：登录时 SDK 尚未就绪的那次 renderMarkers 是空操作，
       SDK 就绪后 initMap 必须补渲染（否则登录后标记/名称标签一直不出来） */
    check('SDK 就绪后会补齐图层并补渲染标记（登录竞态修复）',
      /mapReady = true;\s*ensureMapLayers\(\);[\s\S]{0,300}renderMarkers\(\);/.test(src));
    check('renderMarkers 自带图层兜底重建', /renderMarkers\(\) \{[\s\S]{0,120}ensureMapLayers\(\)/.test(src));
    /* 区域视野：无坐标客户回退省份范围；缩放用边界+容器尺寸反算 */
    check('无坐标客户时回退省份范围',
      /if \(!pts\.length\) \{ focusProvinces\(fallbackProvs \|\| \[\]\); return; \}/.test(src));
    check('缩放级别由边界与容器尺寸反算（含上限收敛）',
      /zoomForBounds\(b, pts\.length\)/.test(src) && /var cap = n <= 2 \? 12 : 15;/.test(src));
  }

  /* 门面回归（高德路径）：updateGeometries 必须按 id 增量更新，不能 prune 掉其他元素 ——
     否则悬浮 / 选中某个客户时只更新它自己的名称标签，其余客户名称会被整体删除。 */
  {
    const marks = [];
    function FakeMarker(o) {
      this.opts = o || {}; this.map = this.opts.map; this.position = this.opts.position;
      this.content = this.opts.content; this.handlers = {};
      marks.push(this);
    }
    FakeMarker.prototype.setMap = function (m) { this.map = m; };
    FakeMarker.prototype.setPosition = function (p) { this.position = p; };
    FakeMarker.prototype.setContent = function (c) { this.content = c; };
    FakeMarker.prototype.setIcon = function () {};
    FakeMarker.prototype.on = function (e, cb) { this.handlers[e] = cb; };

    const F = w.__buildTMapFacade({
      LngLat: function (lng, lat) { this.lng = lng; this.lat = lat; },
      Marker: FakeMarker,
      Map: function () { return {}; }
    });
    const layer = new F.MultiLabel({
      map: { _amap: {} },
      styles: { name: {}, nameOn: { backgroundColor: '#2563EB', color: '#FFFFFF' } }
    });
    layer.setGeometries([
      { id: 'a', styleId: 'name', position: { lat: 37.7, lng: 115.7 }, content: 'A' },
      { id: 'b', styleId: 'name', position: { lat: 37.8, lng: 115.8 }, content: 'B' },
      { id: 'c', styleId: 'name', position: { lat: 37.9, lng: 115.9 }, content: 'C' }
    ]);
    check('门面：3 个客户名称标签都已挂到地图', marks.filter(m => m.map).length === 3);
    layer.updateGeometries([{ id: 'a', styleId: 'nameOn', position: { lat: 37.7, lng: 115.7 }, content: 'A' }]);
    check('门面：updateGeometries 保留其余标签（悬浮时客户名不再消失）',
      marks.filter(m => m.map).length === 3, marks.filter(m => m.map).length + ' 个在图上');
    check('门面：被更新的标签切换为高亮样式',
      marks[0].content.indexOf('background:#2563EB') >= 0, marks[0].content.slice(0, 60));

    const mlayer = new F.MultiMarker({ map: { _amap: {} }, styles: { ok: { width: 26, height: 35 } } });
    mlayer.setGeometries([
      { id: 'm1', styleId: 'ok', position: { lat: 1, lng: 2 } },
      { id: 'm2', styleId: 'ok', position: { lat: 1, lng: 2 } }
    ]);
    mlayer.updateGeometries([{ id: 'm1', styleId: 'ok', position: { lat: 3, lng: 4 } }]);
    check('门面：MultiMarker 同样保留其余标记', marks.filter(m => m.map).length === 5,
      marks.filter(m => m.map).length + ' 个在图上');

    /* 回归：门面必须转发高德地图级 click —— 「在地图上点击拾取客户坐标」依赖它 */
    const mapClickHandlers = [];
    function FakeMap2() {}
    FakeMap2.prototype.on = function (ev, cb) { if (ev === 'click') mapClickHandlers.push(cb); };
    const F2 = w.__buildTMapFacade({
      LngLat: function (lng, lat) { this.lng = lng; this.lat = lat; },
      Marker: FakeMarker,
      Map: FakeMap2
    });
    const tm = new F2.Map('map', { zoom: 5 });
    let got = null;
    tm.on('click', function (evt) { got = evt; });
    mapClickHandlers.forEach(function (h) {
      h({ lnglat: { getLat: function () { return 39.9; }, getLng: function () { return 116.3; } } });
    });
    check('门面：高德地图级 click 已转发（拾取坐标可用）',
      !!got && !!got.latLng
      && Math.abs(got.latLng.getLat() - 39.9) < 1e-9
      && Math.abs(got.latLng.getLng() - 116.3) < 1e-9,
      JSON.stringify(got && got.latLng));
    check('门面：地图对象缺 on 方法时不抛错（测试桩兼容）',
      (function () {
        try {
          const F3 = w.__buildTMapFacade({
            LngLat: function (lng, lat) { this.lng = lng; this.lat = lat; },
            Marker: FakeMarker,
            Map: function () { return {}; }
          });
          new F3.Map('m2', {});
          return true;
        } catch (e) { return false; }
      })());
  }

  w.close();

  const pass = results.filter(r => r[0] === 'PASS').length;
  results.forEach(r => console.log(r[0].padEnd(5) + ' ' + r[1] + (r[2] && r[0] === 'FAIL' ? '   => ' + r[2] : '')));
  console.log('--------------------------------');
  console.log('通过 ' + pass + ' / 共 ' + results.length + '，失败 ' + (results.length - pass));
  if (errors.length) { console.log('运行期错误:'); errors.forEach(x => console.log('  ' + x)); }
  else console.log('运行期错误: 无');
  process.exit(pass === results.length && !errors.length ? 0 : 1);
})();
