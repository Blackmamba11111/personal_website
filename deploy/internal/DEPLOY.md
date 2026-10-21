# 客户巡检台账 · 内部部署运维手册

> 部署时间：2026-10-20 · 部署人：潘超（AI 协助） · 2026-10-20 起启用 HTTPS（443）
> 访问地址：**https://10.1.114.115/inspection-dashboard**（看板）/ **https://10.1.114.115**（首页）
> 明文入口 http://10.1.114.115 仅做 301 跳转到 HTTPS，不提供内容。

## 1. 架构概览

| 组件 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Docker（node:24-bookworm-slim） | 宿主 CentOS 7 已 EOL，Node 22+ 需要 glibc 2.28，容器化规避 |
| TLS | Node 进程内终止（https.createServer） | 内部 CA 自签证书，SAN 含 IP 10.1.114.115，有效期至 2029-01 |
| 服务端 | `server.js`（Node 原生 http） | 由 Cloudflare Workers 版等价移植，接口契约完全一致 |
| 数据库 | SQLite（Node 24 内置 `node:sqlite`） | WAL 模式，单文件 `/data/inspection.db`，零第三方依赖 |
| 静态资源 | 同进程直出 | brotli/gzip 按需压缩，页面 no-cache + ETag/304 |

**为什么零依赖**：本机出口对 Cloudflare 网段（registry.npmjs.org / nodejs.org）不可达，
原生模块（better-sqlite3）编译需下载 Node 头文件会失败；内置 SQLite 使镜像构建全程离线。

## 2. 目录结构

```
/opt/inspection/
├── server.js               # 服务端（静态资源 + /api + TLS 终止）
├── Dockerfile              # 构建文件
├── docker-compose.yml      # 编排（443→8443 HTTPS，80→8080 跳转）
├── certs/                  # 内部 CA 与服务端证书（ca.crt / server.key / server-chain.crt）
├── inspection-dashboard.html / index.html / 404.html / robots.txt / assets/
├── data/                   # 挂载卷：inspection.db（SQLite，WAL）+ photo/hero.jpg（首页照片）
├── backup/                 # 每日备份快照（保留 7 份）
├── backup.sh               # 备份脚本（cron 每天 02:30）
└── reference/              # D1 建表语句、原交接文档
```

### 端口与证书

| 端口 | 用途 |
| --- | --- |
| TCP 443 | HTTPS 主入口（容器内 8443，Node 直接终止 TLS，HSTS 一年） |
| TCP 80 | 仅 301 跳转到 https://，不承载内容 |

**证书是自签的内部 CA 签发**，浏览器首次访问会出现「您的连接不是私密连接」：
点击「高级」→「继续前往 10.1.114.115」即可使用；要消除告警，把 `certs/ca.crt`
分发并安装到各终端的「受信任的根证书颁发机构」（macOS 钥匙串 / Windows certmgr）。
`ca.crt` 也可直接从服务器拷贝：`/opt/inspection/certs/ca.crt`。

**重签证书**：`rm -rf /opt/inspection/certs` 后按 DEPLOY 随附的 gen-certs.sh 流程重签
（改 SAN 时编辑脚本里的 server.ext），然后 `docker compose restart`。

## 3. 初始账号

| 账号 | 初始口令 | 说明 |
| --- | --- | --- |
| admin | `admin888` | **首次登录强制改密（must_change=1）**，请立即修改 |

当前库内数据为平台自带的演示数据（28 家客户示例），可直接用于了解功能；
接手开发时如需干净环境：登录 admin → 删除演示区域/客户，或停服后删除 `data/inspection.db` 重建。

## 4. 日常运维

```bash
cd /opt/inspection
docker compose ps                 # 状态（含健康检查）
docker compose logs -f --tail=100 # 日志（含每个请求一行）
docker compose restart            # 重启
docker compose down && docker compose up -d   # 重建容器（数据在 ./data，不受影响）
```

### 更新页面/服务端

**注意：所有静态文件（html/assets）在构建时被 COPY 进镜像，宿主机上覆盖源文件不会改变线上内容**（容器没有 bind-mount 静态目录）。任何前端或服务端改动，都必须重建镜像：

```bash
# 1. 先更新 /opt/inspection 下的源文件（保持与 git 仓库一致）
# 2. 重建并重启（零依赖镜像，构建约数秒；会短暂中断服务几秒）
docker compose build && docker compose up -d
# 3. 验证：curl -sk https://127.0.0.1/inspection-dashboard | grep -c <新改动特征串>
```

健康检查走容器内 https（自签证书，检查脚本已带 rejectUnauthorized:false），`docker ps` 显示 healthy 即正常。

### 首页照片（上传即持久）

首页照片位点击/拖拽上传后，由 `POST /api/photo` 写入 **`data/photo/hero.jpg`**（挂载卷），
`GET /api/photo/current` 直出（`no-cache` + ETag，换图刷新即生效），点「移除」走
`DELETE /api/photo` 回落到镜像内置的 `assets/hero-photo.jpg`。

- 照片进的是 `data/` 卷，**重建镜像不丢**；不要把上传写到 `/app/assets`（镜像内，rebuild 即失）。
- 备份脚本只备 SQLite，照片请单独拷贝 `data/photo/hero.jpg`。
- 上传接口不要求登录（首页无账号体系），但校验同源 Origin + 文件头（jpg/png/webp）+ 8MB 上限；
  内网环境可接受，若将来开放到不可信网络，应加登录或独立口令。
- 限尺寸：前端先缩到长边 1400、JPEG 质量 0.86 再上传，通常 200–500KB。

### 备份与恢复

```bash
/opt/inspection/backup.sh                          # 手动触发（cron 每天 02:30，保留 7 份）
# 恢复：
docker compose stop
cp backup/inspection-YYYYMMDD-HHMM.db data/inspection.db
docker compose start
```

### 修改端口

编辑 `docker-compose.yml` 的 `ports` 与 `environment.PORT`，然后 `docker compose up -d`。

## 5. 已知事项与坑

1. **腾讯地图 Key**：页面内 Key（`window.TMAP_KEY`）在 `https://10.1.114.115` 下已实测可用
   （`mkey/check` 校验 200）。若后续在腾讯位置服务控制台为该 Key 配置了域名白名单，
   需要把内网 IP 一并登记，否则地图会静默失败（图区出现「加载失败」提示）。
2. **容器内出网受限**：对 Cloudflare 网段不可达；`docker build` 与运行时均不依赖外网。
   后续如需引入 npm 依赖，走 `registry.npmmirror.com`，且原生模块编译需另配头文件镜像。
3. **升级 Node 基础镜像**：`node:sqlite` 要求 Node ≥ 22.5（当前 24.x）。若改用
   better-sqlite3 需恢复编译工具链并解决头文件下载。
4. **改密口径**：前端与 `server.js` 共用「随机盐 + 400 轮 SHA-256」算法；
   任何一侧改动必须同步（另有测试基线 tests/ 在仓库内可回归验证）。
5. **`/assets/provinces.js` 带 `?v=` 版本号**：更换省界/城市数据时必须同步提升
   `inspection-dashboard.html` 内 `PROV_SRC` 与 preload 两处的 `?v=`，否则浏览器用旧缓存。
6. 防火墙（firewalld/iptables）当前均为放行状态；如后来开启，需放行 TCP 18080。

## 6. 回归测试

仓库 `tests/`（`npm install && npm test`，8 套 381 项）与内部服务端共用同一接口契约，
改动 `server.js` 后建议先在开发机跑通再发布。`server.js` 内接口与线上 D1 版一一对应，
便于对照 `HANDOVER.md` 的接口清单。
