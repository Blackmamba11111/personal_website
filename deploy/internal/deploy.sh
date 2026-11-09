#!/bin/bash
# 一键部署内部实例（10.1.114.115）
# 用法：SSH_PASS='口令' bash deploy/internal/deploy.sh            # 部署 + 一致性校验
#       SSH_PASS='口令' bash deploy/internal/deploy.sh --verify   # 只校验 git HEAD ↔ 内网，不动服务
# 前提：本机可直连 10.1.114.115:22；服务器 /opt/inspection 结构见 DEPLOY.md
#
# 【硬性约定】git 仓库里的代码必须与内网运行的代码完全一致。
#   - 部署末尾自动比对 HEAD 中每个文件与服务器文件（含 assets/），不一致直接报错退出；
#   - 有改动还没提交时提示「待提交」，提交推送后跑 --verify 复验。
#   - 公网 Cloudflare 版不再作为设计约束，只保证推送不遗漏。
set -euo pipefail

HOST=10.1.114.115
REMOTE_DIR=/opt/inspection
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TS=$(date +%Y%m%d-%H%M)
# 源文件 → 服务器上的文件名（auth-protocols.mjs / crm-client.mjs 是被 server.js
# 动态加载的共享模块，必须与 server.js 同级；源文件放在 worker/ 下供两版服务端共用）
# Dockerfile / office-cjk.conf 决定镜像是否带 LibreOffice + 中文字体（附件转 PDF 预览），
# 必须一起同步，否则服务器永远用旧镜像、转换功能不生效。
SRC_FILES=(deploy/internal/server.js index.html inspection-dashboard.html worker/auth-protocols.mjs worker/crm-client.mjs deploy/internal/Dockerfile deploy/internal/office-cjk.conf)
DST_FILES=(server.js index.html inspection-dashboard.html auth-protocols.mjs crm-client.mjs Dockerfile office-cjk.conf)
REMOTE_LIST="server.js index.html inspection-dashboard.html auth-protocols.mjs crm-client.mjs Dockerfile office-cjk.conf"

# --verify：只做 git ↔ 内网一致性校验，不上传、不重建
VERIFY_ONLY=false
[ "${1:-}" = "--verify" ] && VERIFY_ONLY=true

: "${SSH_PASS:?用法：SSH_PASS='口令' bash deploy/internal/deploy.sh [--verify]}"

md5_of_stdin() { if command -v md5sum >/dev/null 2>&1; then md5sum | awk '{print $1}'; else md5 -q; fi; }

# 一致性校验：git HEAD ↔ 内网运行代码
# 返回 0=完全一致  3=有改动尚未提交（正常中间态）  1=已提交但与内网不一致
consistency_check() {
  echo "==> 一致性校验：git HEAD ↔ 内网 $REMOTE_DIR"
  local dirty i want got rc=0
  if ! git -C "$REPO_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
    echo "    仓库还没有任何 commit，跳过"; return 3
  fi
  dirty=$(git -C "$REPO_ROOT" status --porcelain -- "${SRC_FILES[@]}" assets 2>/dev/null || true)
  if [ -n "$dirty" ]; then
    echo "    以下改动尚未提交（内网已是最新，但 git 里还没有这个版本）："
    printf '%s\n' "$dirty" | sed 's/^/      /'
    return 3
  fi
  $SSH "cd $REMOTE_DIR && md5sum $REMOTE_LIST" </dev/null > /tmp/cons-remote-src
  for i in "${!SRC_FILES[@]}"; do
    if ! git -C "$REPO_ROOT" cat-file -e "HEAD:${SRC_FILES[$i]}" 2>/dev/null; then
      echo "    ✗ ${DST_FILES[$i]}  git 中没有该文件"; rc=1; continue
    fi
    want=$(git -C "$REPO_ROOT" show "HEAD:${SRC_FILES[$i]}" | md5_of_stdin)
    got=$(awk -v f="${DST_FILES[$i]}" '$2==f{print $1}' /tmp/cons-remote-src)
    if [ "$want" = "$got" ]; then
      echo "    ✓ ${DST_FILES[$i]}"
    else
      echo "    ✗ ${DST_FILES[$i]}  git=$want  内网=$got"; rc=1
    fi
  done
  $SSH "cd $REMOTE_DIR/assets 2>/dev/null && find . -type f ! -name '._*' ! -name '.DS_Store' -print0 | sort -z | xargs -0 md5sum" </dev/null \
    | awk '{print $2"\t"$1}' | sort > /tmp/cons-remote-assets
  git -C "$REPO_ROOT" ls-tree -r --name-only HEAD assets | while IFS= read -r f; do
    printf '%s\t%s\n' ".${f#assets}" "$(git -C "$REPO_ROOT" show "HEAD:$f" | md5_of_stdin)"
  done | sort > /tmp/cons-git-assets
  if diff -q /tmp/cons-git-assets /tmp/cons-remote-assets >/dev/null 2>&1; then
    echo "    ✓ assets/（$(wc -l < /tmp/cons-git-assets | tr -d ' ') 个文件）"
  else
    echo "    ✗ assets/ 与 git 不一致（< 为 git，> 为内网）："
    diff /tmp/cons-git-assets /tmp/cons-remote-assets 2>/dev/null | head -20 | sed 's/^/      /' || true
    rc=1
  fi
  return $rc
}


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

if [ "$VERIFY_ONLY" = true ]; then
  RC=0
  consistency_check || RC=$?
  echo
  if [ "$RC" = 0 ]; then
    echo "==> 一致：git HEAD 就是内网正在运行的代码"
    exit 0
  elif [ "$RC" = 3 ]; then
    echo "!! 还有改动没提交，git 与内网不是同一版本"
  else
    echo "!! 不一致：可能有提交遗漏，或服务器文件被手工改过"
  fi
  exit 2
fi

echo "==> 部署前校验：server.js 必须含 TLS 代码（防旧 HTTP 版覆盖导致 HTTPS 中断）"
grep -q 'https.createServer' "$REPO_ROOT/deploy/internal/server.js" || { echo '!! server.js 缺少 TLS 代码，终止'; exit 1; }

echo "==> 部署前校验：远程认证协议模块必须存在（RADIUS / TACACS+ / LDAP 依赖它）"
[ -f "$REPO_ROOT/worker/auth-protocols.mjs" ] || { echo '!! worker/auth-protocols.mjs 缺失，终止'; exit 1; }

echo "==> 部署前校验：CRM 客户端模块必须存在（询盘云台账关联依赖它）"
[ -f "$REPO_ROOT/worker/crm-client.mjs" ] || { echo '!! worker/crm-client.mjs 缺失，终止'; exit 1; }

echo "==> 部署前校验：Dockerfile 必须安装 LibreOffice 与中文字体（附件原样预览依赖它）"
grep -q 'libreoffice-writer' "$REPO_ROOT/deploy/internal/Dockerfile" || { echo '!! Dockerfile 缺少 LibreOffice，终止'; exit 1; }
grep -q 'fonts-noto-cjk' "$REPO_ROOT/deploy/internal/Dockerfile" || { echo '!! Dockerfile 缺少中文字体，终止'; exit 1; }
[ -f "$REPO_ROOT/deploy/internal/office-cjk.conf" ] || { echo '!! office-cjk.conf 缺失，终止'; exit 1; }

echo "==> 服务器端备份到 backup/src-$TS/"
$SSH "cd $REMOTE_DIR && mkdir -p backup/src-$TS && for f in $REMOTE_LIST; do [ -f \"\$f\" ] && cp -a \"\$f\" backup/src-$TS/; done; true" </dev/null

echo "==> 上传文件"
for i in "${!SRC_FILES[@]}"; do
  $SCP "$REPO_ROOT/${SRC_FILES[$i]}" "root@$HOST:$REMOTE_DIR/${DST_FILES[$i]}" >/dev/null
  echo "    ${DST_FILES[$i]}"
done

echo "==> 同步 assets/ 静态资源（favicon / 省界数据等，整目录覆盖）"
tar -C "$REPO_ROOT" --exclude='._*' --exclude='.DS_Store' -czf /tmp/deploy-assets.tgz assets
$SCP /tmp/deploy-assets.tgz "root@$HOST:/tmp/deploy-assets.tgz" >/dev/null
$SSH "mkdir -p $REMOTE_DIR/assets && cd $REMOTE_DIR && tar -xzf /tmp/deploy-assets.tgz && rm -f /tmp/deploy-assets.tgz" </dev/null
echo "    assets/ 已同步"

echo "==> md5 校验"
( cd "$REPO_ROOT" && md5 -q "${SRC_FILES[@]}" ) > /tmp/deploy-md5-local
$SSH "cd $REMOTE_DIR && md5sum $REMOTE_LIST | awk '{print \$1}'" </dev/null > /tmp/deploy-md5-remote
if ! diff -q /tmp/deploy-md5-local /tmp/deploy-md5-remote >/dev/null; then
  echo '!! md5 不一致，终止（服务器仍是旧文件）'; diff /tmp/deploy-md5-local /tmp/deploy-md5-remote; exit 1
fi
echo "    一致"

echo "==> 重建镜像并重启"
$SSH "cd $REMOTE_DIR && docker compose build 2>&1 | tail -3 && docker compose up -d 2>&1 | tail -3" </dev/null

echo "==> 健康检查"
sleep 4
$SSH "curl -sk https://127.0.0.1/healthz && echo && docker compose -f $REMOTE_DIR/docker-compose.yml ps --format '{{.Status}}'" </dev/null

echo
RC=0
consistency_check || RC=$?
echo
if [ "$RC" = 0 ]; then
  echo "==> 部署完成，且 git HEAD = 内网运行代码"
  echo "==> 回滚：ssh root@$HOST 'cd $REMOTE_DIR && cp -a backup/src-$TS/* . && docker compose build && docker compose up -d'"
elif [ "$RC" = 3 ]; then
  echo "==> 部署完成。git 还是上一版（改动尚未提交），提交并推送后复验："
  echo "    SSH_PASS='口令' bash deploy/internal/deploy.sh --verify"
  echo "==> 回滚：ssh root@$HOST 'cd $REMOTE_DIR && cp -a backup/src-$TS/* . && docker compose build && docker compose up -d'"
else
  echo "!! 服务已更新，但 git HEAD 与内网代码不一致（提交遗漏或服务器被手改）"
  echo "   排查后复验：SSH_PASS='口令' bash deploy/internal/deploy.sh --verify"
  exit 2
fi
