/* 依次执行全部测试套件，任一失败则整体退出码非 0。
   用法：npm test            （需先 npm install）
        node tests/run-all.js
   说明：每个套件都会自己打印 <<通过 N / 共 M>>，这里只汇总退出码与耗时。 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['看板 · 主流程', 'test-board.js'],
  ['看板 · 边界场景', 'test-board-edge.js'],
  ['看板 · 月度口径', 'test-monthly.js'],
  ['看板 · 账号鉴权', 'test-auth.js'],
  ['看板 · 地图图层', 'test-map.js'],
  ['看板 · 客户管理页', 'test-custs.js'],
  ['首页 · 结构与部署产物', 'test-home.js'],
  ['首页 · 照片服务端接口', 'test-photo-api.js'],
  ['看板 · 巡检登记增强', 'test-visits.js'],
  ['看板 · 附件服务端接口', 'test-attach.js'],
  ['看板 · 本地/远程用户与只读权限', 'test-remote-auth.js'],
  ['认证 · RADIUS/TACACS+/LDAP 协议', 'test-protocols.mjs'],
  ['服务端 · Worker 接口（D1 兼容层）', 'test-worker-api.mjs']
];

let failed = 0;
const rows = [];
for (const [label, file] of SUITES) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
  const ms = Date.now() - t0;
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /通过\s+(\d+)\s*\/\s*(?:共\s*)?(\d+)/.exec(out) || /(\d+)\s*\/\s*(\d+)\s*通过/.exec(out);
  const passed = r.status === 0;
  if (!passed) { failed++; console.log('\n----- ' + label + ' 输出 -----\n' + out.trim().split('\n').slice(-25).join('\n')); }
  rows.push({ label, file, stat: m ? m[1] + '/' + m[2] : (passed ? 'OK' : 'FAIL'), ms, passed });
}

console.log('\n===== 汇总 =====');
rows.forEach(r => console.log(
  (r.passed ? 'PASS' : 'FAIL') + '  ' + r.label.padEnd(22) + r.stat.padEnd(9) + (r.ms / 1000).toFixed(1) + 's'));
console.log('----------------');
console.log(failed ? failed + ' 个套件失败' : '全部套件通过');
process.exit(failed ? 1 : 0);
