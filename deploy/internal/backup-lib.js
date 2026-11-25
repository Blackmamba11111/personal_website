'use strict';
/* 备份与恢复核心库（2026-11-25）
 *
 * 设计约束（务必保留这段说明，后续维护者容易踩）：
 *   1. 镜像基于 node:24-bookworm-slim，**不使用任何 npm 依赖**。压缩用系统 tar + gzip
 *      （Debian GNU tar 支持多次 -C，可把不同根目录的条目打进同一个包），
 *      加密用 Node 内置 crypto。scp/sftp/tftp 用 child_process 调系统客户端，
 *      三个包已在 Dockerfile 中安装。
 *   2. SQLite 快照必须用 VACUUM INTO，直接 cp 数据库文件会拿到正在写入的中间状态
 *      （-wal 未合并时尤其危险）。db 实例由调用方传入，本库不 require node:sqlite。
 *   3. 附件目录 189MB，打包时不做复制，直接用 tar 的 -C 从 /data 取上传目录，
 *      避免「先拷一份再压缩」白占一倍磁盘与一倍 IO。
 *   4. 解包前先列表校验条目路径，拒绝绝对路径与 .. 穿越 —— 备份包可能来自人工上传。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MANIFEST_NAME = 'manifest.json';
const DB_NAME = 'inspection.db';
const UPLOAD_DIR = 'uploads';

/* ---------------- 通用 ---------------- */
function run(cmd, args, opts) {
  return new Promise(function (resolve) {
    execFile(cmd, args, Object.assign({ timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, opts || {}),
      function (err, stdout, stderr) {
        resolve({
          ok: !err,
          code: err ? (err.code === undefined ? -1 : err.code) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          msg: err ? (String(stderr || '').trim() || (err.message || '执行失败')) : ''
        });
      });
  });
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function stampLocal(d) {
  const t = d instanceof Date ? d : new Date(d);
  return t.getFullYear() + pad2(t.getMonth() + 1) + pad2(t.getDate()) + '-' + pad2(t.getHours()) + pad2(t.getMinutes());
}
function fmtLocal(d) {
  const t = d instanceof Date ? d : new Date(d);
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) +
    ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
}
function sha256File(file) {
  return new Promise(function (resolve) {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', function (c) { h.update(c); });
    s.on('end', function () { resolve(h.digest('hex')); });
    s.on('error', function () { resolve(''); });
  });
}
function dirStats(dir) {
  let count = 0, bytes = 0;
  try {
    const names = fs.readdirSync(dir);
    names.forEach(function (n) {
      const fp = path.join(dir, n);
      const st = fs.statSync(fp);
      if (st.isFile()) { count++; bytes += st.size; }
    });
  } catch (e) { /* 目录不存在按 0 计 */ }
  return { count: count, bytes: bytes };
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

/* ---------------- 凭据加密 ----------------
   目标服务器的密码 / 私钥落库前加密。密钥文件放在数据目录（随容器挂载，容器重建不丢），
   权限 0600。属于「防数据库被顺手拷走」这一级保护，不防御同机 root。 */
function loadKey(keyFile) {
  ensureDir(path.dirname(keyFile));
  try {
    const buf = fs.readFileSync(keyFile);
    if (buf.length === 32) return buf;
  } catch (e) {}
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  try { fs.chmodSync(keyFile, 0o600); } catch (e) {}
  return key;
}
function encSecret(key, plain) {
  const text = String(plain == null ? '' : plain);
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function decSecret(key, blob) {
  const s = String(blob || '');
  if (!s) return '';
  if (s.indexOf('v1:') !== 0) return s;              /* 兼容未加密的旧值 */
  try {
    const raw = Buffer.from(s.slice(3), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch (e) { return ''; }
}

/* ---------------- 调度计算 ---------------- */
/* freq: 'daily' | 'weekly'；weekly 用 weekday(0=周日…6=周六) + at_time(HH:MM)。
   返回「严格晚于 from」的下一个执行时刻（本地时区，容器 TZ=Asia/Shanghai）。 */
function nextRunOf(task, from) {
  const fromDate = (from instanceof Date) ? from : new Date(from || Date.now());
  const fromMs = fromDate.getTime();
  const m = /^(\d{1,2}):(\d{2})$/.exec(String((task && task.at_time) || '02:30'));
  const hh = m ? Math.max(0, Math.min(23, parseInt(m[1], 10))) : 2;
  const mm = m ? Math.max(0, Math.min(59, parseInt(m[2], 10))) : 30;
  const cand = new Date(fromMs);
  cand.setSeconds(0, 0);
  cand.setHours(hh, mm, 0, 0);
  if (task && task.freq === 'weekly') {
    const wd = Math.max(0, Math.min(6, Number(task.weekday) || 0));
    let guard = 0;
    while ((cand.getDay() !== wd || cand.getTime() <= fromMs) && guard++ < 800) {
      cand.setDate(cand.getDate() + 1);
    }
  } else if (cand.getTime() <= fromMs) {
    cand.setDate(cand.getDate() + 1);
  }
  return cand;
}

/* 内容档位：db=配置与台账；files=巡检报告实体 */
function scopeOf(includeDb, includeFiles) {
  if (includeDb && includeFiles) return 'full';
  if (includeFiles) return 'files';
  return 'config';
}
function backupName(scope, when) {
  return 'inspection-' + stampLocal(when || new Date()) + '-' + scope + '.tar.gz';
}

/* ---------------- 打包 ---------------- */
/* opts: { db, dataDir, outFile, includeDb, includeFiles, tmpDir, host }
   返回 { ok, file, size, manifest, msg } */
async function packBackup(opts) {
  const o = opts || {};
  const dataDir = o.dataDir;
  const outFile = o.outFile;
  const includeDb = !!o.includeDb;
  const includeFiles = !!o.includeFiles;
  if (!dataDir || !outFile) return { ok: false, msg: '缺少 dataDir / outFile' };
  if (!includeDb && !includeFiles) return { ok: false, msg: '未选择备份内容' };
  if (includeDb && !o.db) return { ok: false, msg: '缺少数据库实例，无法生成一致性快照' };
  if (includeFiles && !fs.existsSync(path.join(dataDir, UPLOAD_DIR))) {
    return { ok: false, msg: '附件目录不存在：' + path.join(dataDir, UPLOAD_DIR) };
  }
  ensureDir(path.dirname(outFile));
  const tmpRoot = path.join(o.tmpDir || path.join(dataDir, 'backups', '.tmp'), 'pack-' + crypto.randomBytes(4).toString('hex'));
  ensureDir(tmpRoot);
  try {
    const manifest = {
      app: 'inspection-dashboard',
      version: 1,
      created_at: new Date().toISOString(),
      scope: scopeOf(includeDb, includeFiles),
      contains: { db: includeDb, files: includeFiles },
      host: String(o.host || '')
    };
    const entries = [];
    if (includeDb) {
      /* VACUUM INTO 生成一致快照：等价于完整备份，且不受正在写入的事务影响 */
      const snap = path.join(tmpRoot, DB_NAME);
      try { o.db.exec("VACUUM INTO '" + snap.replace(/'/g, "''") + "'"); }
      catch (e) { return { ok: false, msg: '生成数据库快照失败：' + (e && e.message ? e.message : '未知错误') }; }
      const st = fs.statSync(snap);
      manifest.db = { bytes: st.size, sha256: await sha256File(snap) };
      entries.push({ cwd: tmpRoot, name: DB_NAME });
    }
    if (includeFiles) {
      manifest.files = dirStats(path.join(dataDir, UPLOAD_DIR));
      entries.push({ cwd: dataDir, name: UPLOAD_DIR });
    }
    manifest.entry_count = entries.length;
    const mf = path.join(tmpRoot, MANIFEST_NAME);
    fs.writeFileSync(mf, JSON.stringify(manifest, null, 2), 'utf8');
    entries.push({ cwd: tmpRoot, name: MANIFEST_NAME });

    /* GNU tar：每个条目单独 -C，即可把不同根下的文件压进同一个包 */
    const args = ['-czf', outFile];
    entries.forEach(function (e) { args.push('-C', e.cwd, e.name); });
    const r = await run('tar', args);
    if (!r.ok) { rmrf(outFile); return { ok: false, msg: '打包失败：' + r.msg }; }
    const size = fs.statSync(outFile).size;
    return { ok: true, file: outFile, size: size, manifest: manifest };
  } catch (e) {
    rmrf(outFile);
    return { ok: false, msg: '打包异常：' + (e && e.message ? e.message : '未知错误') };
  } finally {
    rmrf(tmpRoot);
  }
}

/* 备份包可能来自人工上传，解包前必须拦截绝对路径与 .. 穿越 */
function isUnsafeEntry(name) {
  const s = String(name || '');
  return s.indexOf('/') === 0 || s.indexOf('..') === 0 || s.indexOf('/../') >= 0 || /^[A-Za-z]:/.test(s);
}

/* ---------------- 解包与校验 ---------------- */
/* 先读条目清单做路径安全校验，再解压；返回 { ok, manifest, dir, hasDb, hasFiles } */
async function unpackBackup(file, destDir) {
  if (!fs.existsSync(file)) return { ok: false, msg: '备份文件不存在' };
  const list = await run('tar', ['-tzf', file]);
  if (!list.ok) return { ok: false, msg: '不是有效的 tar.gz：' + list.msg };
  const items = list.stdout.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!items.length) return { ok: false, msg: '备份包为空' };
  for (const it of items) {
    if (isUnsafeEntry(it)) return { ok: false, msg: '备份包含非法路径：' + it };
  }
  if (items.indexOf(MANIFEST_NAME) < 0) return { ok: false, msg: '备份包缺少 manifest.json，无法确认来源' };
  ensureDir(destDir);
  const r = await run('tar', ['-xzf', file, '-C', destDir]);
  if (!r.ok) return { ok: false, msg: '解包失败：' + r.msg };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(destDir, MANIFEST_NAME), 'utf8')); }
  catch (e) { return { ok: false, msg: 'manifest.json 损坏' }; }
  if (manifest && manifest.app && manifest.app !== 'inspection-dashboard') {
    return { ok: false, msg: '该备份不属于本系统（' + manifest.app + '）' };
  }
  const dbPath = path.join(destDir, DB_NAME);
  const hasDb = fs.existsSync(dbPath);
  if (hasDb) {
    const fd = fs.openSync(dbPath, 'r');
    const head = Buffer.alloc(16);
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    if (head.toString('latin1', 0, 15) !== 'SQLite format 3') {
      return { ok: false, msg: '包内 inspection.db 不是有效的 SQLite 数据库' };
    }
    if (manifest && manifest.db && manifest.db.sha256) {
      const got = await sha256File(dbPath);
      if (got && got !== manifest.db.sha256) {
        return { ok: false, msg: '数据库校验和不符，备份包可能已损坏' };
      }
    }
  }
  const hasFiles = fs.existsSync(path.join(destDir, UPLOAD_DIR));
  if (!hasDb && !hasFiles) return { ok: false, msg: '备份包内既无数据库也无附件' };
  return { ok: true, manifest: manifest, dir: destDir, dbPath: hasDb ? dbPath : '', filesDir: hasFiles ? path.join(destDir, UPLOAD_DIR) : '' };
}

/* 按保留份数清理本地备份（只删本系统命名的包） */
function pruneLocal(dir, keep) {
  const n = Math.max(1, Number(keep) || 1);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const packs = names.filter(function (f) { return /^inspection-\d{8}-\d{4}-(config|full|files)\.tar\.gz$/.test(f); })
    .map(function (f) {
      const fp = path.join(dir, f);
      let mtime = 0;
      try { mtime = fs.statSync(fp).mtimeMs; } catch (e) {}
      return { f: f, fp: fp, mtime: mtime };
    })
    .sort(function (a, b) { return b.mtime - a.mtime; });
  const removed = [];
  packs.slice(n).forEach(function (p) {
    try { fs.unlinkSync(p.fp); removed.push(p.f); } catch (e) {}
  });
  return removed;
}

/* ---------------- 异地传输 ---------------- */
/* target: { proto:'scp'|'sftp'|'tftp', host, port, user, auth:'password'|'key', secret, remote_dir }
   密码走 sshpass 的环境变量（-e），不落在命令行上，避免 ps 泄露。 */
function sshArgs(target, secretFile) {
  const args = ['-P', String(target.port || 22), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'];
  if (target.auth === 'key') args.push('-i', secretFile);
  return args;
}
async function pushToTarget(target, file, secret) {
  const proto = String(target.proto || '').toLowerCase();
  const host = String(target.host || '').trim();
  const user = String(target.user || '').trim();
  const port = Number(target.port) || (proto === 'tftp' ? 69 : 22);
  const remoteDir = String(target.remote_dir || '').trim().replace(/\/+$/, '');
  const base = path.basename(file);
  if (!host) return { ok: false, msg: '未填写主机地址' };

  if (proto === 'tftp') {
    /* tftp 无认证、明文 UDP；远端路径由服务器自身决定，这里只提交相对文件名 */
    const r = await run('tftp', [host, '-c', 'put', file, base]);
    return { ok: r.ok, msg: r.ok ? '已上传到 tftp://' + host + '/' + base : 'tftp 失败：' + r.msg };
  }
  if (proto !== 'scp' && proto !== 'sftp') return { ok: false, msg: '不支持的协议：' + proto };
  if (!user) return { ok: false, msg: '未填写登录用户' };

  let secretFile = '';
  let batchFile = '';
  const env = Object.assign({}, process.env);
  try {
    if (target.auth === 'key') {
      if (!secret) return { ok: false, msg: '未配置私钥' };
      secretFile = path.join(path.dirname(file), '.key-' + crypto.randomBytes(4).toString('hex'));
      fs.writeFileSync(secretFile, secret.endsWith('\n') ? secret : secret + '\n', { mode: 0o600 });
      try { fs.chmodSync(secretFile, 0o600); } catch (e) {}
    } else {
      if (!secret) return { ok: false, msg: '未配置密码' };
      env.SSHPASS = secret;
    }
    const dest = user + '@' + host + ':' + (remoteDir ? remoteDir + '/' : '');
    let r;
    if (proto === 'scp') {
      const args = sshArgs(target, secretFile).concat([file, dest]);
      r = await run(target.auth === 'password' ? 'sshpass' : 'scp',
        target.auth === 'password' ? ['-e', 'scp'].concat(args) : args, { env: env });
      if (!r.ok && /not found|No such file/i.test(r.msg) && target.auth === 'password') {
        /* sshpass 缺失时给出可操作的提示，而不是一句 command not found */
        return { ok: false, msg: '容器内缺少 sshpass，请重新构建镜像（Dockerfile 已声明该包）' };
      }
    } else {
      /* sftp 用批次文件（execFile 没有 stdin 输入口，走管道会引入引号转义风险） */
      batchFile = path.join(path.dirname(file), '.sftp-' + crypto.randomBytes(4).toString('hex'));
      const remotePath = (remoteDir ? remoteDir + '/' : '') + base;
      fs.writeFileSync(batchFile, 'put "' + file + '" "' + remotePath + '"\n', { mode: 0o600 });
      const args = ['-b', batchFile, '-P', String(port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'];
      if (target.auth === 'key') args.push('-i', secretFile);
      args.push(user + '@' + host);
      r = await run(target.auth === 'password' ? 'sshpass' : 'sftp',
        target.auth === 'password' ? ['-e', 'sftp'].concat(args) : args,
        { env: env });
    }
    return { ok: r.ok, msg: r.ok ? '已上传到 ' + proto + '://' + host + ':' + port + '/' + base : proto + ' 失败：' + r.msg };
  } catch (e) {
    return { ok: false, msg: proto + ' 异常：' + (e && e.message ? e.message : '未知错误') };
  } finally {
    if (secretFile) { try { fs.unlinkSync(secretFile); } catch (e) {} }
    if (batchFile) { try { fs.unlinkSync(batchFile); } catch (e) {} }
  }
}

module.exports = {
  MANIFEST_NAME, DB_NAME, UPLOAD_DIR,
  nextRunOf, scopeOf, backupName, stampLocal, fmtLocal,
  packBackup, unpackBackup, pruneLocal, isUnsafeEntry,
  pushToTarget, loadKey, encSecret, decSecret, dirStats, sha256File
};
