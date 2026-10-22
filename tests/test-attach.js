/* 巡检附件接口测试（deploy/internal/server.js）
   起真实进程 + 临时 DATA_DIR，验证：鉴权、写入、读取（inline/attachment）、类型与大小校验、删除。
   附件的关键约束：文件落 DATA_DIR/uploads（挂载卷），记录入 attachments 表，id 不可猜。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'deploy/internal/server.js');
const SAMPLE = path.join(ROOT, 'assets/hero-photo.jpg');

const results = [];
function check(label, cond, extra) { results.push([cond ? 'PASS' : 'FAIL', label, extra || '']); }
const wait = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise(res => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'attachapi-'));
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;
  const args = [];
  if (parseInt(process.versions.node, 10) < 24) args.push('--experimental-sqlite');
  args.push(SERVER);

  const srv = spawn(process.execPath, args, {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), APP_DIR: ROOT, DATA_DIR: DATA,
      TLS_CERT: path.join(DATA, 'none.crt'), TLS_KEY: path.join(DATA, 'none.key'),
      HTTP_REDIRECT_PORT: '0', NODE_OPTIONS: '--disable-warning=ExperimentalWarning'
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
    console.log('FAIL  服务端未能启动');
    console.log(srvErr.slice(0, 600));
    console.log('---\n通过 0 / 1');
    try { srv.kill('SIGKILL'); } catch (e) {}
    process.exit(1);
  }

  const api = async (p, opts) => {
    opts = opts || {};
    const headers = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    const r = await fetch(BASE + p, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let j = null;
    try { j = await r.json(); } catch (e) {}
    return { status: r.status, j: j };
  };

  try {
    /* 1) 未登录：上传/删除都应 401 */
    let r = await fetch(BASE + '/api/attach', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') })
    });
    check('未登录上传被拒（401）', r.status === 401, String(r.status));
    r = await fetch(BASE + '/api/attach/abcdef123456', { method: 'DELETE' });
    check('未登录删除被拒（401）', r.status === 401, String(r.status));

    /* 2) 登录 */
    let lg = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin888' } });
    const token = lg.j && lg.j.ok && lg.j.data.token;
    check('管理员登录成功并下发 attachMax', !!token && lg.j.data.attachMax > 0,
      lg.j && lg.j.data ? 'attachMax=' + lg.j.data.attachMax : 'no payload');
    check('未上传时读取 404', (await fetch(BASE + '/api/attach/deadbeefdeadbeef')).status === 404);

    /* 3) 上传文本 */
    const txtBody = '巡检记录：机房温湿度正常\n';
    const txtB64 = Buffer.from(txtBody, 'utf8').toString('base64');
    let up1 = await api('/api/attach', {
      method: 'POST', token: token,
      body: { name: '机房巡检记录.txt', mime: 'text/plain', data: txtB64 }
    });
    check('文本附件上传成功', up1.status === 200 && up1.j.ok && !!up1.j.data.id, JSON.stringify(up1.j && up1.j.data));
    const att1 = up1.j.data;
    check('返回读取地址 /api/attach/<id>', att1.url === '/api/attach/' + att1.id);

    const stored = path.join(DATA, 'uploads', att1.id + '.txt');
    check('附件落 DATA_DIR/uploads（挂载卷）', fs.existsSync(stored), stored);
    check('落盘字节与上传一致', fs.existsSync(stored) && fs.readFileSync(stored, 'utf8') === txtBody);

    /* 4) 读取（公开、inline、中文文件名） */
    let g = await fetch(BASE + att1.url);
    const gtxt = await g.text();
    check('附件可公开读取（无需 token）', g.status === 200 && gtxt === txtBody);
    check('文本以内联方式返回', /inline/.test(g.headers.get('content-disposition') || ''),
      g.headers.get('content-disposition'));
    check('中文文件名按 RFC5987 编码', /filename\*=UTF-8''/.test(g.headers.get('content-disposition') || ''));
    check('下发 nosniff', g.headers.get('x-content-type-options') === 'nosniff');

    /* 5) 图片：按文件头纠正为 image/jpeg，可内联预览 */
    const jpgB64 = fs.readFileSync(SAMPLE).toString('base64');
    let up2 = await api('/api/attach', {
      method: 'POST', token: token,
      body: { name: '机房照片', mime: 'application/octet-stream', data: jpgB64 }
    });
    check('图片上传成功（扩展名可缺省，按文件头识别）', up2.j.ok && up2.j.data.mime === 'image/jpeg',
      up2.j && up2.j.data ? up2.j.data.mime : up2.j.error);
    let g2 = await fetch(BASE + up2.j.data.url);
    check('图片按 image/jpeg 返回', g2.status === 200 && g2.headers.get('content-type') === 'image/jpeg');
    check('图片内联（浏览器可直接显示）', /inline/.test(g2.headers.get('content-disposition') || ''));

    /* 5b) 回归：文件名后缀与实际字节不一致（前端把 PNG 重编码成 JPEG 后仍叫 xx.png）
       存盘用嗅探出的 .jpg，读取必须按「存盘真实扩展名」而不是文件名后缀去找。 */
    let up3 = await api('/api/attach', {
      method: 'POST', token: token,
      body: { name: '调整图片尺寸.png', mime: 'image/png', data: jpgB64 }
    });
    check('PNG 名 + JPEG 字节：上传成功并纠正为 image/jpeg',
      up3.j.ok && up3.j.data.mime === 'image/jpeg', JSON.stringify(up3.j && up3.j.data));
    const att3 = up3.j.data;
    check('存盘按嗅探结果落 .jpg（与文件名后缀不同）',
      fs.existsSync(path.join(DATA, 'uploads', att3.id + '.jpg'))
      && !fs.existsSync(path.join(DATA, 'uploads', att3.id + '.png')));
    let g3 = await fetch(BASE + att3.url);
    check('PNG 名 + JPEG 字节：仍可正常读取（曾 404 附件已不存在）', g3.status === 200,
      'status=' + g3.status);
    check('下载文件名跟随真实扩展名（.png → .jpg）',
      /\.jpg"/.test(g3.headers.get('content-disposition') || ''), g3.headers.get('content-disposition'));

    /* 5c) 兼容历史脏数据：ext 为空、文件名后缀也错的旧记录，靠扫目录兜底仍能读 */
    const legacyId = 'legacy' + Date.now().toString(16).slice(-6);
    fs.copyFileSync(path.join(DATA, 'uploads', att3.id + '.jpg'), path.join(DATA, 'uploads', legacyId + '.jpg'));
    const { DatabaseSync } = require('node:sqlite');
    const tdb = new DatabaseSync(path.join(DATA, 'inspection.db'));
    tdb.prepare("INSERT INTO attachments (id, name, mime, size, owner, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(legacyId, '老记录.png', 'image/jpeg', fs.statSync(path.join(DATA, 'uploads', legacyId + '.jpg')).size, 'admin', new Date().toISOString());
    tdb.close();
    let g4 = await fetch(BASE + '/api/attach/' + legacyId);
    check('历史记录（无 ext 列值）仍能读取', g4.status === 200, 'status=' + g4.status);


    /* 6) 非法内容 / 不支持的类型 */
    let bad1 = await api('/api/attach', {
      method: 'POST', token: token,
      body: { name: 'evil.exe', mime: 'application/x-msdownload', data: Buffer.alloc(2048, 0x41).toString('base64') }
    });
    check('不支持的类型被拒', bad1.status === 400 && !bad1.j.ok, bad1.j && bad1.j.error);

    let bad2 = await api('/api/attach', { method: 'POST', token: token, body: { name: 'x.txt', data: '' } });
    check('空内容被拒', bad2.status === 400 && !bad2.j.ok, bad2.j && bad2.j.error);

    /* 7) 删除 */
    let del = await api('/api/attach/' + att1.id, { method: 'DELETE', token: token });
    check('删除附件成功', del.j && del.j.ok && del.j.data.removed === true, JSON.stringify(del.j && del.j.data));
    check('磁盘文件已清理', !fs.existsSync(stored));
    check('删除后读取 404', (await fetch(BASE + att1.url)).status === 404);
    check('重复删除幂等', (await api('/api/attach/' + att1.id, { method: 'DELETE', token: token })).j.data.removed === false);

    /* 8) 台账中的 atts 数组原样保存 */
    const put = await api('/api/ledger', {
      method: 'PUT', token: token,
      body: {
        scope: 'admin',
        data: {
          regions: [], customers: [{ id: 'c1', name: 'A' }],
          visits: [{ id: 'v1', customerId: 'c1', date: '2026-10-21', mode: 'remote', result: 'other', atts: [att1] }]
        }
      }
    });
    check('台账写入成功（含 mode/result/atts）', put.j && put.j.ok);
    const got = await api('/api/ledger', { token: token });
    const v = got.j && got.j.data && got.j.data.ledgers && got.j.data.ledgers.admin &&
      got.j.data.ledgers.admin.visits && got.j.data.ledgers.admin.visits[0];
    check('服务端保存 mode=remote', v && v.mode === 'remote', v && v.mode);
    check('服务端保存 result=other', v && v.result === 'other', v && v.result);
    check('服务端保存附件引用', v && v.atts && v.atts.length === 1 && v.atts[0].url,
      v && v.atts ? v.atts.length + ' 个' : '无');
  } catch (e) {
    check('测试过程未抛异常', false, (e && e.stack ? e.stack : String(e)).slice(0, 300));
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
