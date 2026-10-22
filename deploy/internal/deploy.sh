#!/bin/bash
# 一键部署内部实例（10.1.114.115）
# 用法：SSH_PASS='口令' bash deploy/internal/deploy.sh
# 前提：本机可直连 10.1.114.115:22；服务器 /opt/inspection 结构见 DEPLOY.md
set -euo pipefail

HOST=10.1.114.115
REMOTE_DIR=/opt/inspection
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TS=$(date +%Y%m%d-%H%M)
FILES=(deploy/internal/server.js index.html inspection-dashboard.html)

: "${SSH_PASS:?用法：SSH_PASS='口令' bash deploy/internal/deploy.sh}"

# --- askpass 免交互（macOS 无 sshpass） ---
ASKPASS=$(mktemp /tmp/deploy-askpass.XXXXXX)
trap 'rm -f "$ASKPASS" /tmp/deploy-askpass.lock' EXIT
printf '#!/bin/sh\nprintf "%%s\\n" "$SSH_PASS"\n' "$SSH_PASS" > "$ASKPASS"
chmod 700 "$ASKPASS"
export SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force DISPLAY=:0
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)
SSH="ssh ${SSH_OPTS[*]} root@$HOST"
SCP="scp ${SSH_OPTS[*]}"

echo "==> 连接测试"
$SSH 'echo OK' </dev/null

echo "==> 部署前校验：server.js 必须含 TLS 代码（防旧 HTTP 版覆盖导致 HTTPS 中断）"
grep -q 'https.createServer' "$REPO_ROOT/deploy/internal/server.js" || { echo '!! server.js 缺少 TLS 代码，终止'; exit 1; }

echo "==> 服务器端备份到 backup/src-$TS/"
$SSH "cd $REMOTE_DIR && mkdir -p backup/src-$TS && cp -a server.js index.html inspection-dashboard.html backup/src-$TS/" </dev/null

echo "==> 上传文件"
for f in "${FILES[@]}"; do
  $SCP "$REPO_ROOT/$f" "root@$HOST:$REMOTE_DIR/$(basename "$f")" >/dev/null
  echo "    $(basename "$f")"
done

echo "==> md5 校验"
( cd "$REPO_ROOT" && md5 -q "${FILES[@]}" ) > /tmp/deploy-md5-local
$SSH "cd $REMOTE_DIR && md5sum server.js index.html inspection-dashboard.html | awk '{print \$1}'" </dev/null > /tmp/deploy-md5-remote
if ! diff -q /tmp/deploy-md5-local /tmp/deploy-md5-remote >/dev/null; then
  echo '!! md5 不一致，终止（服务器仍是旧文件）'; diff /tmp/deploy-md5-local /tmp/deploy-md5-remote; exit 1
fi
echo "    一致"

echo "==> 重建镜像并重启"
$SSH "cd $REMOTE_DIR && docker compose build 2>&1 | tail -3 && docker compose up -d 2>&1 | tail -3" </dev/null

echo "==> 健康检查"
sleep 4
$SSH "curl -sk https://127.0.0.1/healthz && echo && docker compose -f $REMOTE_DIR/docker-compose.yml ps --format '{{.Status}}'" </dev/null

echo "==> 完成。回滚：ssh root@$HOST 'cd $REMOTE_DIR && cp -a backup/src-$TS/* . && docker compose build && docker compose up -d'"
