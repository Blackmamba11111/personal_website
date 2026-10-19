# 撒啦嘿 · 个人主页

一个个人主页 + 一个多账号的数据看板：前端零构建（单文件 HTML），后端一个 Cloudflare Worker
加一个 D1 库（免费额度足够个人/小团队使用）提供账号体系与跨设备台账同步。

- **首页** `index.html` —— 高级黑视觉，鼠标跟随粒子、一束会呼吸的玫瑰、个人照片
- **数据看板** `inspection-dashboard.html` —— 登录后可用的可视化工作台（地图视角 / 台账 / 季度追溯 / 多账号数据隔离），
  工具栏内含独立的**「客户管理」页**：集中查看与维护客户基础资料（增删改查，不含巡检数据）；
  新增 / 编辑客户的省市联动覆盖全部 34 个省级行政区（497 项城市候选，选城市自动带坐标）
- **404** `404.html` —— 与站点同风格的自定义错误页

---

## 目录结构

```
.
├── index.html                  # 首页（单文件，内联样式与脚本）
├── inspection-dashboard.html   # 数据看板（单文件，含登录与用户管理）
├── 404.html                    # 自定义 404
├── assets/
│   ├── favicon.svg             # 站点图标
│   ├── hero-photo.jpg          # 首页照片（可直接替换同名文件）
│   ├── rose-a.webp             # 玫瑰素材
│   ├── rose-b.webp
│   └── provinces.js            # 省界轮廓 + 城市候选（388 KB，看板按需异步加载）
├── worker/
│   ├── index.js                # 服务端：/api/* 路由（鉴权 + 台账 + 用户管理）
│   └── schema.sql              # D1 建表语句（含初始超管）
├── wrangler.jsonc              # Workers 配置（静态资源 + D1 绑定 + /api/* 优先交给 Worker）
├── .assetsignore               # 上传排除清单（.git / .wrangler / worker / README 等）
├── robots.txt
└── README.md
```

> **`_headers` 已彻底移除**：Workers 静态资源**不会更新已存在的 `_headers` 文件**（改内容后
> 仍报 `No updated asset files`），会让线上长期下发一份改不动的旧策略——曾因此把地图样式域名
> `mapstyle.qpic.cn` 挡在 CSP 之外，导致底图全灰。现在 CSP 由页面 `meta` 声明，其余安全头
> 由 `worker/index.js` 在响应阶段注入。**请勿再新增 `_headers`。**

## 本地预览

不要直接双击打开 `index.html`：浏览器对 `file://` 的本地存储限制较多（照片缓存会失效），
且看板的地图需要联网加载。用任意静态服务器即可：

```bash
# 方式一：Python 自带
python3 -m http.server 8080

# 方式二：Node
npx serve -l 8080
```

然后访问 <http://127.0.0.1:8080/>。

> 参数 `?still=1` 会关闭动画与粒子循环，只渲染一帧，方便截图或打印：
> `http://127.0.0.1:8080/?still=1`

## 关于照片

首页照片按三级顺序自动选取：**浏览器本地缓存 → 同目录约定文件 → 手动上传**。
所以你有两种替换方式：

1. **换文件**：把新图命名成 `hero-photo.jpg` 覆盖 `assets/` 里的同名文件（推荐，所有访客都能看到）；
2. **页面内上传**：点击首页照片选择图片，会压缩到 1400px 后存在**你自己浏览器**里（只有本机可见）。

照片与玫瑰都是无框设计，边缘做了羽化，直接融入黑底；换图时建议用深色背景、人物居中的竖构图。

## 看板为什么拆出 `assets/provinces.js`

省界轮廓与城市候选原本是看板里的内联字面量，占整页 588 KB 的三分之二。内联时它必须随页面
一起下载并解析完，末尾那段主脚本才开始执行——在跨洋慢链路上就表现为「登录框很久点不动」。

现在数据独立成 `assets/provinces.js`，由看板在登录界面出现后异步注入，与登录流程完全解耦：

| 指标 | 拆分前 | 拆分后 |
| --- | --- | --- |
| 主文档 | 588 KB（brotli 216 KB） | 206 KB（brotli 47 KB） |
| 登录可交互所需字节 | 216 KB | 47 KB（约 1/4.6） |
| 回访（数据已在缓存） | 216 KB | 47 KB + 0 |

- `/assets/*` 由 Worker 下发 `max-age=31536000, immutable`，配合 URL 上的 `?v=` 版本号，
  回访与新开标签页不再重复下载省界数据。
- 数据未到达时地图区域退化为「中心点圆圈」、省份下拉暂空；到达后自动补齐并重绘，功能不中断。

> **改数据时必改版本号**：`inspection-dashboard.html` 里的 `PROV_SRC` 与 `<link rel="preload">`
> 两处 `?v=` 必须同步提升，否则浏览器会继续使用一年期缓存里的旧副本。

## 部署到 GitHub + Cloudflare Pages

### 1) 推送到 GitHub

已推送到 <https://github.com/Blackmamba11111/personal_website>（分支 `main`）。日常只需：

```bash
git add -A
git commit -m "说明这次改了什么"
git push
```

> 推送凭证不保存在仓库里（`.git/config` 只有干净的 `https://` 地址）。
> 建议在 GitHub 生成一个仅含 `repo` 权限的 **Personal access token**，用完即删；
> 或者配置 SSH key 后把远程地址换成 `git@github.com:...` 以免去每次输入。

### 2) 接 Cloudflare（Workers 静态资源）

1. Cloudflare 控制台 → **Workers & Pages** → **Create** → 连接 Git 仓库，选中 `personal_website`；
2. 构建配置**保持自动检测即可**（无需手填）：

   | 项 | 值 |
   |---|---|
   | Worker 名称 | `personal-website` |
   | Framework | `Static` |
   | Deploy command | `npx wrangler deploy` |
   | Output directory | `.` |

3. 点 **Deploy**。之后每次 `git push` 都会自动重新发布。

`.assetsignore`（上传排除）放在**仓库根目录**即自动生效，不需要额外配置。

绑定自定义域名：项目 → **Settings → Domains & Routes** → 添加域名并按提示改 DNS（Cloudflare 自动签发证书）。

### 3) 服务端台账（D1）——首次部署要做一次

看板的数据不再只存在浏览器里，而是存在 Cloudflare D1（免费额度：5 GB 存储 / 每天 500 万次读、
10 万次写，个人及小团队用量绰绰有余）。

**前提**：`wrangler.jsonc` 里已绑定数据库 `inspection_ledger`
（`database_id` 已填好，区域选在亚太以降低国内访问延迟）。

首次建表（在本机执行一次即可）：

```bash
# 建库（若尚未创建）：npx wrangler d1 create inspection_ledger
npx wrangler d1 execute inspection_ledger --remote --file=./worker/schema.sql
```

`worker/schema.sql` 会建三张表并在缺省时插入初始账号：

| 表 | 用途 |
|---|---|
| `users` | 账号、角色（admin/user）、状态、加盐 400 轮 SHA-256 口令 |
| `ledgers` | 每个账号一份台账 JSON（`username` 主键） |
| `sessions` | 登录令牌（30 天有效，退出即删） |

**初始超管**：账号 `admin`、密码 `admin888`，且标记为「首次登录必须改密」。
登录后会被强制拦在改密弹窗里，改完才能进入看板——所以请第一时间改掉它。

### 4) 部署失败排查

构建日志里如果出现下面这类报错，是 `_headers` 格式问题（不是代码问题）：

```
Invalid _headers configuration:
Line 2: Expected a path before headers [code: 100324]
```

含义：有响应头没有紧跟在**顶格的路径行**后面。本仓库已不再使用 `_headers`（见上），
若你另外新增了它，请把全局头归到 `/*` 路径块下，路径行顶格、响应头行缩进两空格。

其它常见现象：

- **线上还是旧页面**：Workers 静态资源的 HTML/404 有边缘缓存（响应头 `cf-cache-status: HIT`），
  部署成功后等 1~2 分钟再刷新；HTML 本身已被 Worker 标成 `no-cache`。
- **`/api/*` 返回 404**：说明 `wrangler.jsonc` 的 `assets.run_worker_first` 没生效或 Worker 没发上去，
  检查构建日志里是否出现 `Worker Name: personal-website`。
- **地图仍然空白**：先确认浏览器控制台没有 CSP 违规；再看是不是**硬件加速被关**——
  看板地图区提供了「检测显卡支持」按钮，会直接给出判断依据。

同时请确认 `.assetsignore` 生效——早期没有它时，`.git/` 整个目录会被当成静态资源上传
（日志里能看到 `+ /.git/HEAD` 之类的行），既浪费体积也可能暴露仓库历史。

### 5) 发布前检查清单

- [ ] 首页照片已换成你想要的版本（`assets/hero-photo.jpg`）
- [ ] 看板地图密钥已配置（见下一节；不配也能用，只是地图区域会提示不可用）
- [ ] 看板超管初始密码 `admin888` 已修改（首次登录会被强制要求改）
- [ ] `worker/schema.sql` 已在目标 D1 库执行过
- [ ] 确认 `.workbuddy/`、`hero-photo.png` 等本地文件没有被提交（`.gitignore` 已处理）

---

## 看板的地图密钥（重要）

沙箱预览环境会自动注入地图代理，**线上环境不会**。因此线上要显示真实底图，需要：

1. 到 [腾讯位置服务控制台](https://lbs.qq.com/) 申请一个 **WebService/JavaScript GL** 类型的 Key，
   并在 Key 的域名白名单里填上你的 Cloudflare 域名（如 `your-site.pages.dev` 和自有域名）；
2. 打开 `inspection-dashboard.html`，在**文件靠前的头部区域**找到这一行：

```html
<script>window.TMAP_KEY = '把这里换成你的 Key';</script>
```

3. 只改引号之间的内容，提交推送即可（当前线上已配置好一个 Key，换 Key 时改这一行）。

未配置 Key 时看板不会白屏：地图区域会显示「地图未能加载」的提示，**左侧客户列表、季度统计、录入与检索功能都照常可用**。

## 数据与安全说明

- **数据存在服务端**（Cloudflare D1），换电脑、换浏览器登录同一账号即可看到同一份台账；
  浏览器 `localStorage` 只是镜像缓存，用于断网时继续录入，联网后自动回推。
- 多账号数据按用户名隔离：普通用户只能读写自己的台账，超管可查看/切换全部账号，并有一个
  只读的「汇总」视图。看板的「客户管理」页同样遵守这套边界：普通用户只见自己的客户；
  超管在汇总视图下跨账号**只读**检索全部客户，切到某个账号即可代录，写入该账号台账。
- 口令以**加盐 + 400 轮 SHA-256** 哈希保存，服务端与前端使用同一套算法；登录由服务端签发
  Bearer Token（30 天），退出即失效，改密会踢掉其它设备上的会话。
- 传输全程 HTTPS；页面通过 `meta` 声明 CSP，响应侧另加 `nosniff` / `referrer-policy` /
  `permissions-policy`。
- 初始超管 `admin` / `admin888` 带「首次登录必须改密」标记，**请在首次登录后立刻修改**。
- `robots.txt` 已阻止搜索引擎收录看板页面，但请勿把看板当作公开可访问的私密系统。

## 技术要点

- **零依赖零构建**：所有样式与脚本内联在两个 HTML 文件里，不需要 npm、不需要打包，CDN 直接托管。
- **动画**：玫瑰由脚本按参数生成（每朵独立定位、朝向、摇摆与开合节奏，后排花朵带景深虚化），
  配合飘落花瓣、闪星、金色浮尘与掠过花束的光扫；鼠标粒子场为 Canvas 2D 手写实现。
- **降级**：尊重 `prefers-reduced-motion`（减弱动画）；`?still=1` 静态模式；
- **无障碍**：语义化标签、可键盘操作的图片选择区、图片与图形的 `aria-label`。

## 许可

个人站点，未附带开源许可。除看板外的视觉与文案请勿直接商用转载。
