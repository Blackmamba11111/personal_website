/* 首页照片服务端接口测试（deploy/internal/server.js）
   —— 起一个真实进程（临时 DATA_DIR、随机端口），验证上传/读取/304/删除全链路。
   关键约束：照片必须落在 DATA_DIR（挂载卷）里，写进镜像内的 /app/assets 会在
   下次 docker build 后丢失，故此处显式断言落盘路径。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'deploy/internal/server.js');
const SAMPLE = path.join(ROOT, 'assets/hero-photo.jpg');

const results = [];
function check(label, cond, extra) {
  results.push([cond ? 'PASS' : 'FAIL', label, extra || '']);
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise(res => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

(async () => {
  if (!fs.existsSync(SAMPLE)) {
    console.log('FAIL  缺少样例图片 assets/hero-photo.jpg');
    console.log('---\n通过 0 / 1');
    process.exit(1);
  }

  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'photoapi-'));
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;
  const args = [];
  if (parseInt(process.versions.node, 10) < 24) args.push('--experimental-sqlite');
  args.push(SERVER);

  const srv = spawn(process.execPath, args, {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      APP_DIR: ROOT,
      DATA_DIR: DATA,
      TLS_CERT: path.join(DATA, 'none.crt'),
      TLS_KEY: path.join(DATA, 'none.key'),
      HTTP_REDIRECT_PORT: '0',
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvErr = '';
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', d => { srvErr += String(d); });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) { up = true; break; } } catch (e) {}
    await wait(150);
  }
  if (!up) {
    console.log('FAIL  服务端未能启动（node ' + process.versions.node + ' 需 node:sqlite）');
    console.log(srvErr.slice(0, 600));
    console.log('---\n通过 0 / 1');
    try { srv.kill('SIGKILL'); } catch (e) {}
    process.exit(1);
  }

  try {
    /* 1) 未上传 */
    let r = await fetch(BASE + '/api/photo/current');
    check('未上传时 GET 返回 404', r.status === 404, String(r.status));

    /* 2) 内容校验：伪装成 jpeg 的随机字节必须被拒 */
    r = await fetch(BASE + '/api/photo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'data:image/jpeg;base64,' + Buffer.alloc(4096, 0x41).toString('base64') })
    });
    let j = await r.json();
    check('非图片内容按文件头被拒绝', r.status === 400 && !j.ok, j.error);

    /* 3) 正常上传 */
    const jpg = fs.readFileSync(SAMPLE);
    r = await fetch(BASE + '/api/photo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'data:image/jpeg;base64,' + jpg.toString('base64') })
    });
    j = await r.json();
    check('上传成功并返回读取地址', r.ok && j.ok && j.data && j.data.url === '/api/photo/current', JSON.stringify(j.data));

    const stored = path.join(DATA, 'photo', 'hero.jpg');
    check('落盘到 DATA_DIR/photo（持久卷，重建镜像不丢）', fs.existsSync(stored), stored);
    check('落盘字节与上传一致', fs.existsSync(stored) && fs.statSync(stored).size === jpg.length);
    check('未写入 APP_DIR/assets（镜像内，rebuild 会丢）',
      !fs.existsSync(path.join(ROOT, 'assets', 'hero-upload.jpg')));

    /* 4) 读取与缓存协商 */
    r = await fetch(BASE + '/api/photo/current');
    const buf = Buffer.from(await r.arrayBuffer());
    check('GET 返回图片', r.ok && /image\/jpeg/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
    check('返回内容与上传一致', buf.length === jpg.length && buf.slice(0, 3).toString('hex') === 'ffd8ff');
    check('Cache-Control: no-cache（换图即时生效）', /no-cache/.test(r.headers.get('cache-control') || ''));
    const etag = r.headers.get('etag');
    r = await fetch(BASE + '/api/photo/current', { headers: { 'if-none-match': etag } });
    check('带 If-None-Match 返回 304', r.status === 304, String(r.status));

    /* 5) 删除 */
    r = await fetch(BASE + '/api/photo', { method: 'DELETE' });
    j = await r.json();
    check('DELETE 成功', r.ok && j.ok && j.data && j.data.removed === true, JSON.stringify(j.data));
    check('磁盘文件已删除', !fs.existsSync(stored));
    r = await fetch(BASE + '/api/photo/current');
    check('删除后 404（前端回落默认图）', r.status === 404, String(r.status));
  } catch (e) {
    check('测试过程未抛异常', false, (e && e.message) || String(e));
  }

  const pass = results.filter(x => x[0] === 'PASS').length;
  results.forEach(x => console.log(x[0] + '  ' + x[1] + (x[2] ? '  [' + x[2] + ']' : '')));
  console.log('---');
  console.log('通过 ' + pass + ' / ' + results.length);

  try { srv.kill('SIGTERM'); } catch (e) {}
  await wait(250);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(pass === results.length ? 0 : 1);
})();
