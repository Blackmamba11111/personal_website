/* 备份与恢复 · 单元与集成测试
 *
 * 覆盖三层：
 *   1. backup-lib 纯逻辑：调度计算、内容档位、命名、凭据加解密、保留清理
 *   2. 真实打包/解包往返（node:sqlite 临时库 + 真实 tar），含恶意包拒绝
 *   3. 接线断言：服务端路由、恢复期间的 503 拦截、镜像依赖、部署清单、前端引用
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const DIR = path.join(__dirname, '..');
const BK = require(path.join(DIR, 'deploy/internal/backup-lib.js'));

const results = [];
function check(name, cond, detail) {
  results.push([cond ? 'PASS' : 'FAIL', name, detail === undefined ? '' : String(detail)]);
}

/* ---------------- 1. 纯逻辑 ---------------- */
(function scheduleTests() {
  const from = new Date(2026, 10, 25, 10, 0, 0);            /* 2026-11-25 10:00 本地 */
  const d1 = BK.nextRunOf({ freq: 'daily', at_time: '02:30' }, from);
  check('每天 02:30：已过点则排到次日', BK.fmtLocal(d1) === '2026-11-26 02:30', BK.fmtLocal(d1));

  const d2 = BK.nextRunOf({ freq: 'daily', at_time: '23:00' }, from);
  check('每天 23:00：未到点则当天执行', BK.fmtLocal(d2) === '2026-11-25 23:00', BK.fmtLocal(d2));

  const d3 = BK.nextRunOf({ freq: 'weekly', weekday: 0, at_time: '03:00' }, from);
  check('每周日 03:00：命中周日且晚于当前', BK.fmtLocal(d3) === '2026-11-29 03:00' && d3.getDay() === 0, BK.fmtLocal(d3));

  /* 2026-11-25 是周三：设周三 09:00（已过）应排到下周同一时刻 */
  const d4 = BK.nextRunOf({ freq: 'weekly', weekday: 3, at_time: '09:00' }, from);
  check('每周三 09:00：当天已过则顺延一周', BK.fmtLocal(d4) === '2026-12-02 09:00', BK.fmtLocal(d4));

  const d5 = BK.nextRunOf({ freq: 'daily', at_time: '乱填' }, from);
  check('非法时间回退为 02:30', /02:30$/.test(BK.fmtLocal(d5)), BK.fmtLocal(d5));

  const d6 = BK.nextRunOf({ freq: 'daily', at_time: '25:99' }, from);
  check('越界时间被夹到合法值', /^\d{4}-\d{2}-\d{2} 2[0-3]:[0-5]\d$/.test(BK.fmtLocal(d6)), BK.fmtLocal(d6));

  check('内容档位 full', BK.scopeOf(true, true) === 'full');
  check('内容档位 config', BK.scopeOf(true, false) === 'config');
  check('内容档位 files', BK.scopeOf(false, true) === 'files');

  const nm = BK.backupName('full', new Date(2026, 10, 25, 2, 30));
  check('备份包命名带时间与档位', /^inspection-20261125-0230-full\.tar\.gz$/.test(nm), nm);
})();

(function cryptoTests() {
  const key = Buffer.alloc(32, 9);
  const enc = BK.encSecret(key, 'p@ss"w0rd\n中文');
  check('凭据加密带版本前缀', enc.indexOf('v1:') === 0, enc.slice(0, 8));
  check('凭据加解密往返一致', BK.decSecret(key, enc) === 'p@ss"w0rd\n中文');
  check('错误密钥解不出明文', BK.decSecret(Buffer.alloc(32, 1), enc) === '');
  check('空值不加密', BK.encSecret(key, '') === '');
  check('兼容未加密旧值', BK.decSecret(key, 'plain-old') === 'plain-old');
})();

/* ---------------- 2. 打包 / 解包 ---------------- */
function makeSource() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bkt-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'uploads', 'a.doc'), 'report-a');
  fs.writeFileSync(path.join(dataDir, 'uploads', 'b.pdf'), Buffer.alloc(2048, 5));
  fs.mkdirSync(path.join(dataDir, 'preview'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'preview', 'x.pdf'), 'cache');
  const dbFile = path.join(dataDir, 'inspection.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE t (x TEXT)');
  db.exec("INSERT INTO t VALUES ('台账一')");
  return { root, dataDir, db, dbFile };
}

(async function packTests() {
  const src = makeSource();
  try {
    /* 全量 */
    const outFull = path.join(src.root, 'inspection-20261125-0230-full.tar.gz');
    const rFull = await BK.packBackup({
      db: src.db, dataDir: src.dataDir, outFile: outFull,
      includeDb: true, includeFiles: true, tmpDir: path.join(src.root, 'tmp'), host: 'test-host'
    });
    check('全量打包成功', rFull.ok === true, rFull.msg || '');
    check('全量包体积大于 0', rFull.ok && rFull.size > 0, rFull.size);
    check('manifest 记录内容档位', rFull.ok && rFull.manifest.scope === 'full', rFull.ok ? rFull.manifest.scope : '');
    check('manifest 记录数据库校验和', rFull.ok && /^[0-9a-f]{64}$/.test(rFull.manifest.db.sha256 || ''), '');
    check('manifest 记录附件数量与字节', rFull.ok && rFull.manifest.files.count === 2 && rFull.manifest.files.bytes === 2056,
      rFull.ok ? JSON.stringify(rFull.manifest.files) : '');
    check('打包不包含预览缓存', rFull.ok && !execFileSync('tar', ['-tzf', outFull]).toString().includes('preview'),
      execFileSync('tar', ['-tzf', outFull]).toString().replace(/\n/g, ' '));

    const uFull = await BK.unpackBackup(outFull, path.join(src.root, 'r-full'));
    check('全量解包成功', uFull.ok === true, uFull.msg || '');
    check('解包后数据库存在', uFull.ok && !!uFull.dbPath);
    check('解包后附件存在', uFull.ok && fs.existsSync(path.join(uFull.filesDir, 'a.doc')));

    /* 仅配置 */
    const outCfg = path.join(src.root, 'inspection-20261125-0231-config.tar.gz');
    const rCfg = await BK.packBackup({
      db: src.db, dataDir: src.dataDir, outFile: outCfg, includeDb: true, includeFiles: false
    });
    check('仅配置打包成功', rCfg.ok === true, rCfg.msg || '');
    check('仅配置包确实不含附件', rCfg.ok && !execFileSync('tar', ['-tzf', outCfg]).toString().includes('uploads'),
      rCfg.ok ? execFileSync('tar', ['-tzf', outCfg]).toString().replace(/\n/g, ' ') : '');
    const uCfg = await BK.unpackBackup(outCfg, path.join(src.root, 'r-cfg'));
    check('仅配置包解出数据库、无附件目录', uCfg.ok && !!uCfg.dbPath && uCfg.filesDir === '');

    /* 仅巡检报告 */
    const outFiles = path.join(src.root, 'inspection-20261125-0232-files.tar.gz');
    const rFiles = await BK.packBackup({
      db: src.db, dataDir: src.dataDir, outFile: outFiles, includeDb: false, includeFiles: true
    });
    check('仅报告打包成功', rFiles.ok === true, rFiles.msg || '');
    const uFiles = await BK.unpackBackup(outFiles, path.join(src.root, 'r-files'));
    check('仅报告包解出附件、无数据库', uFiles.ok && !uFiles.dbPath && !!uFiles.filesDir);

    /* 参数校验 */
    const bad = await BK.packBackup({ db: src.db, dataDir: src.dataDir, outFile: path.join(src.root, 'x.tar.gz'), includeDb: false, includeFiles: false });
    check('未选内容时拒绝打包', bad.ok === false && /未选择/.test(bad.msg), bad.msg);

    /* 缺 manifest 的包 */
    const noManifestDir = path.join(src.root, 'no-manifest');
    fs.mkdirSync(noManifestDir, { recursive: true });
    fs.writeFileSync(path.join(noManifestDir, 'inspection.db'), 'not a db');
    const nmPack = path.join(src.root, 'no-manifest.tar.gz');
    execFileSync('tar', ['-czf', nmPack, '-C', noManifestDir, 'inspection.db']);
    const uNm = await BK.unpackBackup(nmPack, path.join(src.root, 'r-nm'));
    check('缺 manifest 的包被拒绝', uNm.ok === false && /manifest/.test(uNm.msg), uNm.msg);

    /* manifest 正常但 db 不是 SQLite */
    const fakeDbDir = path.join(src.root, 'fake-db');
    fs.mkdirSync(fakeDbDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDbDir, 'inspection.db'), 'this is not sqlite at all');
    fs.writeFileSync(path.join(fakeDbDir, 'manifest.json'), JSON.stringify({
      app: 'inspection-dashboard', version: 1, scope: 'config', contains: { db: true, files: false }
    }));
    const fakePack = path.join(src.root, 'fake-db.tar.gz');
    execFileSync('tar', ['-czf', fakePack, '-C', fakeDbDir, 'inspection.db', 'manifest.json']);
    const uFake = await BK.unpackBackup(fakePack, path.join(src.root, 'r-fake'));
    check('包内 db 非 SQLite 被拒绝', uFake.ok === false && /SQLite/.test(uFake.msg), uFake.msg);

    /* 校验和不符 */
    const tamperDir = path.join(src.root, 'tamper');
    fs.mkdirSync(tamperDir, { recursive: true });
    fs.copyFileSync(src.dbFile, path.join(tamperDir, 'inspection.db'));
    const goodHash = await BK.sha256File(path.join(tamperDir, 'inspection.db'));
    fs.appendFileSync(path.join(tamperDir, 'inspection.db'), Buffer.from('tampered'));
    fs.writeFileSync(path.join(tamperDir, 'manifest.json'), JSON.stringify({
      app: 'inspection-dashboard', version: 1, scope: 'config',
      contains: { db: true, files: false }, db: { sha256: goodHash }
    }));
    const tamperPack = path.join(src.root, 'tamper.tar.gz');
    execFileSync('tar', ['-czf', tamperPack, '-C', tamperDir, 'inspection.db', 'manifest.json']);
    const uTamper = await BK.unpackBackup(tamperPack, path.join(src.root, 'r-tamper'));
    check('校验和不符被拒绝', uTamper.ok === false && /校验和/.test(uTamper.msg), uTamper.msg);

    /* 路径穿越防护（直接测判定函数：本机 tar 是 bsdtar，构造恶意包的方式与 GNU tar 不同） */
    check('拦截绝对路径条目', BK.isUnsafeEntry('/etc/passwd') === true);
    check('拦截上溯路径条目', BK.isUnsafeEntry('../x') === true && BK.isUnsafeEntry('a/../../etc/passwd') === true);
    check('拦截 Windows 盘符条目', BK.isUnsafeEntry('C:\\win\\x') === true);
    check('放行正常条目', BK.isUnsafeEntry('uploads/a.doc') === false && BK.isUnsafeEntry('inspection.db') === false);

    /* 保留份数清理：目录里共 4 个包，保留 1 份 → 删掉最旧的 3 个 */
    const oldFile = path.join(src.root, 'inspection-20260101-0000-config.tar.gz');
    fs.writeFileSync(oldFile, 'old');
    const past = new Date(Date.now() - 86400000);
    fs.utimesSync(oldFile, past, past);
    const removed = BK.pruneLocal(src.root, 1);
    check('按保留份数删除旧包', removed.length === 3 && removed.indexOf('inspection-20260101-0000-config.tar.gz') >= 0,
      removed.join(','));
    check('保留份数内最新包仍在', fs.existsSync(outFiles));
  } finally {
    try { src.db.close(); } catch (e) {}
    try { fs.rmSync(src.root, { recursive: true, force: true }); } catch (e) {}
  }

  /* ---------------- 3. 接线断言 ---------------- */
  const srv = fs.readFileSync(path.join(DIR, 'deploy/internal/server.js'), 'utf8');
  const lib = fs.readFileSync(path.join(DIR, 'deploy/internal/backup-lib.js'), 'utf8');
  const ui = fs.readFileSync(path.join(DIR, 'assets/backup.js'), 'utf8');
  const dash = fs.readFileSync(path.join(DIR, 'inspection-dashboard.html'), 'utf8');
  const docker = fs.readFileSync(path.join(DIR, 'deploy/internal/Dockerfile'), 'utf8');
  const deploySh = fs.readFileSync(path.join(DIR, 'deploy/internal/deploy.sh'), 'utf8');

  check('服务端加载备份核心库', /require\('\.\/backup-lib\.js'\)/.test(srv));
  check('备份接口仅超管可用', /p\.indexOf\('\/api\/backup'\) === 0[\s\S]{0,120}!isAdmin/.test(srv));
  check('支持立即备份接口', /p === '\/api\/backup\/run' && method === 'POST'/.test(srv));
  check('支持用已有包恢复', /p === '\/api\/backup\/restore' && method === 'POST'/.test(srv));
  check('支持上传包恢复', /p === '\/api\/backup\/restore-upload' && method === 'POST'/.test(srv));
  check('上传恢复在请求体解析之前拦截（二进制流）',
    srv.indexOf("'/api/backup/restore-upload'") < srv.indexOf('let body = {};'));
  check('恢复期间非备份接口返回 503', /RESTORING && p\.indexOf\('\/api\/backup'\) !== 0/.test(srv) && /503/.test(srv));
  check('数据库连接可关闭重开（恢复换库）', /let db;[\s\S]{0,200}function openDb\(\)/.test(srv) && /db\.close\(\)/.test(srv));
  check('恢复前生成回滚点', /rollback[\s\S]{0,200}VACUUM INTO/.test(srv));
  check('恢复后清空会话强制重登', /DELETE FROM sessions/.test(srv));
  check('定时任务每分钟调度一次', /setInterval\(function \(\) \{\s*backupTick\(\)/.test(srv));
  check('三张备份配置表已建立', /CREATE TABLE IF NOT EXISTS backup_targets/.test(srv) &&
    /CREATE TABLE IF NOT EXISTS backup_tasks/.test(srv) && /CREATE TABLE IF NOT EXISTS backup_runs/.test(srv));
  check('目标服务器支持三种协议', /scp'\) < 0|'scp', 'sftp', 'tftp'/.test(srv));
  check('凭据加密存储', /BK\.encSecret\(bkKey\(\)/.test(srv) && /BK\.decSecret\(bkKey\(\)/.test(srv));
  check('连通性测试用探针文件', /\.probe-/.test(srv));
  check('打包用 VACUUM INTO 取一致快照', /VACUUM INTO/.test(lib) && /packBackup/.test(lib));
  check('打包用 tar 多 -C 避免复制附件', /entries\.forEach\(function \(e\) \{ args\.push\('-C'/.test(lib));
  check('解包校验路径穿越', /非法路径/.test(lib));
  check('scp/sftp 密码走 sshpass 环境变量', /sshpass/.test(lib) && /env\.SSHPASS/.test(lib));
  check('镜像安装传输客户端', /openssh-client/.test(docker) && /sshpass/.test(docker) && /tftp-hpa/.test(docker));
  check('部署清单纳入 backup-lib.js', /deploy\/internal\/backup-lib\.js/.test(deploySh) && /backup-lib\.js/.test(deploySh));
  check('看板引用备份页面脚本', /assets\/backup\.js\?v=1/.test(dash));
  check('备份入口挂在账号菜单', /umBackup/.test(ui) && /isAdmin\(\)/.test(ui));
  check('界面支持下载到本机', /backup\/download\?name=/.test(ui));
  check('界面支持上传包恢复', /restore-upload/.test(ui) && /XMLHttpRequest/.test(ui));
  check('界面支持多目标多选', /bkTargetPick/.test(ui) && /pickedTargets/.test(ui));
  check('界面支持定时任务自定义', /bkTFreq/.test(ui) && /bkTKeep/.test(ui));

  /* ---------------- 输出 ---------------- */
  const pass = results.filter(function (r) { return r[0] === 'PASS'; }).length;
  console.log('===== 备份与恢复测试 =====');
  results.forEach(function (r) { console.log(r[0] + '  ' + r[1] + (r[2] ? '   [' + r[2] + ']' : '')); });
  console.log('-----');
  console.log('通过 ' + pass + ' / 共 ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
})().catch(function (e) {
  console.error('测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
