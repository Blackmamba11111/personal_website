/* ============================================================
   tmap-stub.js —— 腾讯地图 SDK 的最小可用桩
   目的：在 jsdom 中让 initMap() 成功、mapReady 置位，
   从而覆盖「地图已就绪」这条主运行路径（真实浏览器里走的正是它）。
   桩会记录各图层的几何数据，便于断言带洞轮廓、标记数量与图层重建。
   ============================================================ */
function installTMap(window) {
  const rec = { layers: [], map: null };

  class LatLng {
    constructor(lat, lng) { this.lat = lat; this.lng = lng; }
    getLat() { return this.lat; }
    getLng() { return this.lng; }
  }
  class Style { constructor(o) { Object.assign(this, o || {}); } }
  class Map {
    constructor(id, o) {
      this.id = id; this.opts = o || {};
      this.center = this.opts.center; this.zoom = this.opts.zoom;
      this.handlers = {};
      rec.map = this;
    }
    on(e, cb) { (this.handlers[e] = this.handlers[e] || []).push(cb); }
    setCenter(ll) { this.center = ll; }
    setZoom(z) { this.zoom = z; }
    getBounds() {
      return { getNorthEast: () => new LatLng(41.1, 119.5), getSouthWest: () => new LatLng(36.0, 113.4) };
    }
    getZoom() { return this.zoom; }
    destroy() {}
  }
  class Layer {
    constructor(o) {
      this.opts = o || {};
      this.geometries = (o && o.geometries) || [];
      this.styles = (o && o.styles) || {};
      this.map = (o && o.map) || null;
      this.handlers = {};
      this.setGeometriesCalls = 0;
      this.__kind = 'Layer';
      rec.layers.push(this);
    }
    on(e, cb) { (this.handlers[e] = this.handlers[e] || []).push(cb); }
    setGeometries(g) { this.geometries = g || []; this.setGeometriesCalls++; }
    getGeometries() { return this.geometries; }
    setMap(m) { this.map = m; }
  }
  /* 每种图层带上类型标识，便于测试按「最新实例」定位当前生效的图层，
     而不是误取之前已 setMap(null) 的历史实例。 */
  function mkLayer(kind) {
    return class extends Layer {
      constructor(o) { super(o); this.__kind = kind; }
    };
  }
  class InfoWindow {
    constructor(o) { this.opts = o || {}; this.isOpen = true; }
    setPosition(p) { this.opts.position = p; }
    setContent(c) { this.opts.content = c; }
    open() { this.isOpen = true; }
    close() { this.isOpen = false; }
  }

  window.TMap = {
    Map, LatLng, InfoWindow,
    MarkerStyle: Style, PolygonStyle: Style, CircleStyle: Style, LabelStyle: Style,
    MultiMarker: mkLayer('MultiMarker'),
    MultiPolygon: mkLayer('MultiPolygon'),
    MultiCircle: mkLayer('MultiCircle'),
    MultiLabel: mkLayer('MultiLabel'),
    service: {}
  };
  window.__TMAP = rec;
  return rec;
}
module.exports = { installTMap };
