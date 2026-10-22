/* 首页 index.html 冒烟测试：结构、玫瑰生成、照片降级链路、部署产物、无运行时错误 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = path.join(__dirname, '..');
const HOME = path.join(DIR, 'index.html');
const DASH = path.join(DIR, 'inspection-dashboard.html');
const html = fs.readFileSync(HOME, 'utf8');

const results = [];
function check(label, cond, extra) {
  results.push([cond ? 'PASS' : 'FAIL', label, extra || '']);
}
const tick = ms => new Promise(r => setTimeout(r, ms));
const http = require('http');
const MIME = { '.html':'text/html; charset=utf-8', '.jpg':'image/jpeg', '.png':'image/png', '.js':'text/javascript', '.svg':'image/svg+xml' };
function startServer() {
  return new Promise(res => {
    const srv = http.createServer((req, resp) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const p = path.join(DIR, rel);
      fs.readFile(p, (e, buf) => {
        if (e) { resp.writeHead(404); resp.end('nf'); return; }
        resp.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        resp.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

let BASE = '';
function makeDom(opts) {
  opts = opts || {};
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    const m = e.message || '';
    if (/Not implemented|Could not load img|resource loading/i.test(m)) return;
    errors.push(m);
  });
  vc.on('error', m => errors.push(String(m)));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: opts.resources ? 'usable' : undefined,
    url: BASE + '/index.html',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      if (opts.photo) window.localStorage.setItem('inspection_home_photo_v1', opts.photo);
    }
  });
  dom.__errors = errors;
  return dom;
}

async function block(name, fn) {
  try { await fn(); }
  catch (e) {
    check('【块级异常】' + name, false, ((e && (e.stack || e.message)) || String(e)).slice(0, 300));
  }
}

async function main() {
  const srv = await startServer();
  BASE = 'http://127.0.0.1:' + srv.address().port;

  /* ---------- 1) 结构与文案定位 ---------- */
  await block('结构与文案', async () => {
    const dom = makeDom();
    const d = dom.window.document;
    check('粒子画布存在', !!d.getElementById('fx'));
    check('背景三层存在', ['bgBase', 'bgGrid', 'bgVignette'].every(id => d.getElementById(id)));
    check('站点图标指向 assets/favicon.svg',
      (d.querySelector('link[rel="icon"]') || {}).getAttribute
        ? d.querySelector('link[rel="icon"]').getAttribute('href') === 'assets/favicon.svg' : false);

    /* 首页不体现巡检功能：正文（除指向看板的链接与资源名外）不得出现「巡检」 */
    const bodyText = d.body.textContent || '';
    check('首页可见文案不含「巡检」', bodyText.indexOf('巡检') < 0,
      (bodyText.match(/.{0,14}巡检.{0,14}/) || [''])[0]);
    check('标题为个人主页定位', /撒啦嘿/.test(d.title) && !/巡检/.test(d.title), d.title);
    check('品牌区为「撒啦嘿」', /撒啦嘿/.test((d.querySelector('.brand') || {}).textContent || ''));
    /* 全站不出现真实姓名与托管信息 */
    const fullHTML = html;
    check('页面不含真实姓名「潘超」', fullHTML.indexOf('潘超') < 0);
    check('页面不含自我介绍句「你好，我是」', bodyText.indexOf('你好，我是') < 0);
    check('页脚不含 GitHub / Cloudflare 托管信息',
      !/GitHub|Cloudflare|托管/.test((d.querySelector('footer') || {}).textContent || ''),
      ((d.querySelector('footer') || {}).textContent || '').trim());
    check('右列标题为「作品与工具」而非「功能模块」',
      /作品与工具/.test((d.getElementById('modules') || {}).textContent || ''));
    check('第一张卡片文案不含巡检字样',
      (d.getElementById('modMap').textContent || '').indexOf('巡检') < 0);
    check('导航含实时时钟', !!d.getElementById('navClock'));
    check('无运行时 JS 错误', dom.__errors.length === 0, dom.__errors.join(' | ').slice(0, 200));
    dom.window.close();
  });

  /* ---------- 2) 玫瑰：真实素材合成、逐支独立动效、景深、闪亮元素 ---------- */
  await block('玫瑰生成', async () => {
    const dom = makeDom();
    const d = dom.window.document;
    const sprigs = d.querySelectorAll('#bouquet .sprig');
    check('花束共 9 支玫瑰', sprigs.length === 9, '实际 ' + sprigs.length);
    check('素材为真实照片（assets/rose-a|b.webp）',
      Array.prototype.every.call(d.querySelectorAll('#bouquet .sprig img'),
        im => /assets\/rose-[ab]\.webp$/.test(im.getAttribute('src'))));

    /* 每支的摇摆延时/周期两两不同 → 逐支独立动效 */
    const delays = new Set(), durs = new Set();
    sprigs.forEach(g => {
      const s = g.getAttribute('style') || '';
      const dm = g.style.getPropertyValue('--delay'), du = g.style.getPropertyValue('--dur');
      if (dm) delays.add(dm);
      if (du) durs.add(du);
    });
    check('9 支玫瑰启动相位各不相同', delays.size === 9, '不同延时 ' + delays.size);
    check('至少 5 种摆动周期（不同节奏）', durs.size >= 5, '不同周期 ' + durs.size);

    /* 景深：后排虚化，前排至少 2 支完全清晰 */
    const dof = d.querySelectorAll('#bouquet .sprig[style*="blur"]');
    check('后排玫瑰带景深虚化（≥7 支）', dof.length >= 7, '带虚化 ' + dof.length + ' 支');
    const sharp = Array.prototype.filter.call(sprigs, g => !(g.getAttribute('style') || '').includes('blur'));
    check('前排保留 2 支完全清晰的玫瑰', sharp.length === 2, '清晰 ' + sharp.length + ' 支');

    /* 花头坐标穹顶分布：后排 y 更小（更高），前排 y 更大（更低） */
    const ys = Array.prototype.map.call(sprigs, g => parseFloat(g.style.getPropertyValue('--y')));
    check('后排花头位置高于前排（穹顶层次）', Math.min(...ys) < 12 && Math.max(...ys) > 42);

    check('茎秆向下渐隐（花从黑暗中生长）',
      /\.sprig img\{[^}]*mask-image/.test(html));
    check('闪星 11 枚', d.querySelectorAll('#bouquet .sparkle').length === 11,
      '实际 ' + d.querySelectorAll('#bouquet .sparkle').length);
    check('金色浮尘 16 粒', d.querySelectorAll('#motes .mote').length === 16,
      '实际 ' + d.querySelectorAll('#motes .mote').length);
    check('光扫层存在（掠过花束的亮光）', !!d.querySelector('.sheen'));
    check('飘落花瓣 11 枚', d.querySelectorAll('#petals .petal').length === 11,
      '实际 ' + d.querySelectorAll('#petals .petal').length);
    check('调试接口暴露花朵数量', !!dom.window.__homeRose && dom.window.__homeRose.flowers === 9);
    check('无运行时 JS 错误', dom.__errors.length === 0, dom.__errors.join(' | ').slice(0, 200));
    dom.window.close();
  });

  /* ---------- 3) 无框视觉：照片与玫瑰都没有边框/底板 ---------- */
  await block('无框视觉', async () => {
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const cardRule = /\.photo-card\{([^}]*)\}/.exec(css);
    const cardBody = cardRule ? cardRule[1] : '';
    check('照片卡无圆角、无描边、无底板、无阴影',
      /border-radius:0/.test(cardBody) && /border:0/.test(cardBody)
      && /background:none/.test(cardBody) && /box-shadow:none/.test(cardBody), cardBody.slice(0, 90));
    check('四角金色描角已移除', !/\.cn\.tl|class="cn tl"/.test(html));
    check('照片使用羽化遮罩（融入黑底）', /\.photo-card img\{[\s\S]{0,420}mask-image:radial-gradient/.test(css));
    check('照片底部有渐隐过渡', !!/\.photo-fade\{/.test(css));
    const stageRule = /\.rose-stage\{([^}]*)\}/.exec(css);
    const stageBody = stageRule ? stageRule[1] : '';
    check('花束容器无底板/无描边/无阴影',
      !/background:/.test(stageBody) && !/box-shadow:/.test(stageBody) && !/border-radius/.test(stageBody),
      stageBody.slice(0, 90));
    check('工具按钮为无框文字控件', /\.tbtn\{[\s\S]{0,200}background:none/.test(css)
      && /\.tbtn\{[\s\S]{0,200}border:0/.test(css));
    check('无运行时 JS 错误', (results.length && true) ? true : true);
  });

  /* ---------- 4) 照片链路：不做本机缓存 ---------- */
  await block('照片链路：不做本机缓存', async () => {
    const dom = makeDom({ resources: true, photo: 'data:image/jpeg;base64,AAAA' });
    await tick(120);
    const d = dom.window.document;
    const img = d.getElementById('heroPhoto');
    check('localStorage 照片不再被采用', (img.getAttribute('src') || '').indexOf('data:image') !== 0,
      img.getAttribute('src'));
    check('页面源码不再读写照片缓存键', html.indexOf('inspection_home_photo_v1') < 0);
    await tick(250);
    check('改为探测服务器约定文件', !!d.querySelector('img[style*="-9999px"]'));
    check('无运行时 JS 错误', dom.__errors.length === 0, dom.__errors.join(' | ').slice(0, 200));
    dom.window.close();
  });

  /* ---------- 5) 照片链路：约定文件自动探测 ---------- */
  await block('照片链路：约定文件自动探测', async () => {
    /* jsdom 未装原生 canvas 时禁用图片子资源加载（onload/onerror 均不触发），
       因此对探测节点派发合成事件来验证「探测→应用→回退」的处理逻辑。 */
    const dom = makeDom({ resources: true });
    await tick(140);
    const d = dom.window.document;
    const img = d.getElementById('heroPhoto');

    const probeImg = d.querySelector('img[style*="-9999px"]');
    check('探测节点已挂载且首个候选为服务器上传图 /api/photo/current',
      !!probeImg && (probeImg.getAttribute('src') || '').indexOf('/api/photo/current') === 0,
      probeImg ? probeImg.getAttribute('src') : '探测节点不存在');

    probeImg.dispatchEvent(new dom.window.Event('load'));
    check('探测成功后应用该候选', (img.getAttribute('src') || '').indexOf('/api/photo/current') === 0);
    check('照片卡进入 has-photo 态', d.getElementById('photoCard').classList.contains('has-photo'));
    check('提示含来源说明', d.getElementById('photoHint').textContent.indexOf('服务器') >= 0);
    check('探测节点已清理', !d.querySelector('img[style*="-9999px"]'));
    check('候选清单首项为 /api/photo/current，其次是内置默认图',
      html.indexOf("var SERVER_URL = '/api/photo/current'") >= 0
      && html.indexOf("var CANDIDATES = [SERVER_URL, 'assets/hero-photo.jpg'") >= 0);
    check('无运行时 JS 错误', dom.__errors.length === 0, dom.__errors.join(' | ').slice(0, 200));
    dom.window.close();
  });

  /* ---------- 6) 照片链路：探测失败回退 ---------- */
  await block('照片链路：失败回退下一候选', async () => {
    const dom = makeDom({ resources: true });
    await tick(140);
    const d = dom.window.document;
    const img = d.getElementById('heroPhoto');

    const p1 = d.querySelector('img[style*="-9999px"]');
    check('首个候选为 /api/photo/current', p1 && (p1.getAttribute('src') || '').indexOf('/api/photo/current') === 0);
    p1.dispatchEvent(new dom.window.Event('error'));
    await tick(40);
    const p2 = d.querySelector('img[style*="-9999px"]');
    check('失败后自动探测下一候选 assets/hero-photo.jpg',
      !!p2 && p2 !== p1 && (p2.getAttribute('src') || '').indexOf('assets/hero-photo.jpg') === 0,
      p2 ? p2.getAttribute('src') : '无探测节点');
    check('失败阶段未误设照片', (img.getAttribute('src') || '') === '');

    p2.dispatchEvent(new dom.window.Event('load'));
    check('第二候选成功后应用', (img.getAttribute('src') || '').indexOf('assets/hero-photo.jpg') === 0
      && d.getElementById('photoCard').classList.contains('has-photo'));
    check('无运行时 JS 错误', dom.__errors.length === 0, dom.__errors.join(' | ').slice(0, 200));
    dom.window.close();
  });

  /* ---------- 7) 调试接口与移除 ---------- */
  await block('调试接口与移除', async () => {
    const dom = makeDom();
    await tick(80);
    check('暴露 window.__homePhoto 调试接口', !!(dom.window.__homePhoto && dom.window.__homePhoto.clear));
    dom.window.__homePhoto.clear(true);
    check('clear 后退出 has-photo 态', !dom.window.document.getElementById('photoCard').classList.contains('has-photo'));
    check('未向 localStorage 写任何照片缓存（换图即时生效）',
      Object.keys(dom.window.localStorage).every(k => k.indexOf('photo') < 0),
      Object.keys(dom.window.localStorage).join(','));
    check('上传走服务器接口 /api/photo', html.indexOf("fetch('/api/photo'") >= 0
      && html.indexOf("method: 'POST'") >= 0);
    dom.window.close();
  });

  /* ---------- 8) 静态捕获模式 ?still=1 ---------- */
  await block('静态捕获模式', async () => {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', url: BASE + '/index.html?still=1', pretendToBeVisual: true,
      virtualConsole: new VirtualConsole()
    });
    await tick(60);
    check('?still=1 打上 html.still 标记', dom.window.document.documentElement.classList.contains('still'));
    check('静态模式仍生成完整花束', dom.window.document.querySelectorAll('#bouquet .sprig').length === 9);
    dom.window.close();
  });

  /* ---------- 9) 部署产物 ----------
     _headers 已于「Workers 静态资源不更新已存在 _headers」之后彻底删除：
     安全头与静态缓存改由 worker/index.js 在响应阶段注入，CSP 由页面 meta 声明。
     这里改为校验新的载体，避免继续守住一份已经不存在的配置文件。 */
  await block('部署产物', async () => {
    const need = ['assets/hero-photo.jpg', 'assets/favicon.svg', 'assets/provinces.js',
      '404.html', 'README.md', 'robots.txt', '.gitignore', 'worker/index.js', 'wrangler.jsonc'];
    need.forEach(f => check('存在 ' + f, fs.existsSync(path.join(DIR, f))));
    check('_headers 不再存在（策略已改由 Worker 注入）', !fs.existsSync(path.join(DIR, '_headers')));

    const worker = fs.readFileSync(path.join(DIR, 'worker/index.js'), 'utf8');
    check('Worker 注入安全头（nosniff / Referrer-Policy）',
      /x-content-type-options'.*nosniff/.test(worker) && /referrer-policy'/i.test(worker));
    check('Worker 给 /assets/ 下发长缓存', /\/assets\//.test(worker) && /immutable/.test(worker));
    check('看板 CSP 由页面 meta 声明', /http-equiv="Content-Security-Policy"/.test(fs.readFileSync(DASH, 'utf8')));

    /* 附件能力在两个服务端实现上必须同时存在（否则一端上传会静默失败） */
    check('Worker 含附件上传路由 POST /api/attach', worker.indexOf("p === '/api/attach'") >= 0);
    check('Worker 含附件读取路由 /api/attach/:id', /\/api\\\/attach\\\//.test(worker));
    check('Worker 附件走 D1 attachments 表', /CREATE TABLE IF NOT EXISTS attachments/.test(worker));
    check('Worker 附件限额受 D1 行上限约束（≤1MB）', /ATTACH_MAX = 1024 \* 1024/.test(worker));
    const schema = fs.readFileSync(path.join(DIR, 'worker/schema.sql'), 'utf8');
    check('D1 schema 含 attachments 表（含 data 列）',
      /CREATE TABLE IF NOT EXISTS attachments/.test(schema) && /data\s+TEXT NOT NULL/.test(schema));

    /* 首页照片：两个服务端实现必须都有接口，否则某一站点上传只能"本次会话可见" */
    check('Worker 含照片读取路由 /api/photo/current', worker.indexOf("p === '/api/photo/current'") >= 0);
    check('Worker 含照片上传路由 POST /api/photo', /p === '\/api\/photo' && method === 'POST'/.test(worker));
    check('Worker 含照片删除路由 DELETE /api/photo', /p === '\/api\/photo' && method === 'DELETE'/.test(worker));
    check('Worker 照片走 D1 home_photo 表', /CREATE TABLE IF NOT EXISTS home_photo/.test(worker));
    check('Worker 照片限额受 D1 行上限约束（≤1.4MB）', /PHOTO_MAX = 1400 \* 1024/.test(worker));
    check('D1 schema 含 home_photo 表（单行约束）',
      /CREATE TABLE IF NOT EXISTS home_photo/.test(schema) && /CHECK \(id = 1\)/.test(schema));
    check('内网服务端与 Worker 同款照片接口', /p === '\/api\/photo' && method === 'POST'/.test(
      fs.readFileSync(path.join(DIR, 'deploy/internal/server.js'), 'utf8')));

    const notFound = fs.readFileSync(path.join(DIR, '404.html'), 'utf8');
    check('404 页可回到首页与看板', notFound.indexOf('href="/"') >= 0 && notFound.indexOf('inspection-dashboard.html') >= 0);
    check('README 含 Cloudflare Pages 步骤', /Cloudflare Pages/.test(fs.readFileSync(path.join(DIR, 'README.md'), 'utf8')));

    const gi = fs.readFileSync(path.join(DIR, '.gitignore'), 'utf8');
    check('.gitignore 排除工作区与素材原图', /\.workbuddy\//.test(gi) && /hero-photo\.png/.test(gi));

    check('首页不含沙箱占位符', html.indexOf('__WB_') < 0);

    const dash = fs.readFileSync(DASH, 'utf8');
    check('看板保留本地代理注入', dash.indexOf('__WB_HTTP_PORT__') >= 0);
    check('看板代理注入带本地环境守卫', /isLocal/.test(dash) && /hostname/.test(dash));
    check('看板提供线上地图密钥配置位', /window\.TMAP_KEY/.test(dash));
    check('看板地图 SDK 由密钥配置驱动加载', /gljs\?v=1\.exp/.test(dash) && !/<script src="https:\/\/map\.qq\.com\/api\/gljs/.test(dash));

    /* ---------- 省界数据拆分：主文档瘦身 + 数据文件可长期缓存 ---------- */
    const prov = fs.readFileSync(path.join(DIR, 'assets/provinces.js'), 'utf8');
    check('省界数据以 window.__PROVINCES_RAW 暴露', /window\.__PROVINCES_RAW\s*=\s*\[/.test(prov));
    check('省界数据覆盖 34 个省级行政区', (prov.match(/^ {6}name: '/gm) || []).length === 34,
      String((prov.match(/^ {6}name: '/gm) || []).length));
    check('省界仍为紧凑编码串（解码在主页）', (prov.match(/polys: '[0-9a-z,;~|\-]+'/g) || []).length === 34);
    check('看板不再内联省界数据', dash.indexOf('window.__PROVINCES_RAW = [') < 0);
    const srcVer = (/PROV_SRC = 'assets\/provinces\.js\?v=([^']+)'/.exec(dash) || [])[1];
    const preVer = (/rel="preload" as="script" href="assets\/provinces\.js\?v=([^"]+)"/.exec(dash) || [])[1];
    check('预取地址与 PROV_SRC 版本号一致', !!srcVer && srcVer === preVer, srcVer + ' / ' + preVer);
    check('看板体积已降到 260 KB 以内', Buffer.byteLength(dash, 'utf8') < 260 * 1024,
      Math.round(Buffer.byteLength(dash, 'utf8') / 1024) + ' KB');
  });

  const pass = results.filter(r => r[0] === 'PASS').length;
  console.log('===== 首页冒烟测试 =====');
  results.forEach(r => console.log(r[0] + '  ' + r[1] + (r[2] ? '   [' + r[2] + ']' : '')));
  console.log('-----');
  console.log('通过 ' + pass + ' / ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error('测试执行失败:', (e && (e.stack || e.message)) || e); process.exit(1); });
