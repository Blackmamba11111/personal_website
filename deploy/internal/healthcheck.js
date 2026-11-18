#!/usr/bin/env node
/**
 * 容器健康检查（Dockerfile 的 HEALTHCHECK 调用它）
 *
 * 历史坑：原先直接内联在 Dockerfile 里，写死 `http://127.0.0.1:${PORT}/healthz`。
 * 服务后来改成「进程内 TLS」（compose 里 PORT=8443 走 HTTPS），探针却仍发明文 HTTP，
 * 于是容器从启动起就一直 unhealthy（实测连续失败 4135 次 ≈ 35 小时），
 * 而服务本身完全正常（80 → 301、443 → 200）。排障时极易被误导。
 *
 * 现在的做法：
 *   1. 按 TLS_CERT 是否存在决定先试哪种协议，另一种作为兜底；
 *   2. 忽略自签证书 —— 只在容器内环回探测，不涉及对外流量；
 *   3. 端口一律读 PORT，与 compose 保持一致，不再出现两处写死。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');

const PORT = Number(process.env.PORT || 18080);
const TIMEOUT = 3500;
const ORDER = process.env.TLS_CERT ? ['https', 'http'] : ['http', 'https'];

function probe(proto) {
  return new Promise(function (resolve) {
    const lib = proto === 'https' ? https : http;
    let req;
    try {
      req = lib.get({
        host: '127.0.0.1',
        port: PORT,
        path: '/healthz',
        rejectUnauthorized: false,
        timeout: TIMEOUT
      }, function (res) {
        res.resume();
        resolve(res.statusCode === 200);
      });
    } catch (e) {
      return resolve(false);
    }
    req.on('timeout', function () { req.destroy(); resolve(false); });
    req.on('error', function () { resolve(false); });
  });
}

(async function () {
  for (let i = 0; i < ORDER.length; i++) {
    if (await probe(ORDER[i])) process.exit(0);
  }
  process.exit(1);
})();
