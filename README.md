# 撒啦嘿 · 个人主页

一个纯静态的个人主页 + 一个多账号的数据看板。零依赖、零构建，直接托管即可访问。

- **首页** `index.html` —— 高级黑视觉，鼠标跟随粒子、一束会呼吸的玫瑰、个人照片
- **数据看板** `inspection-dashboard.html` —— 登录后可用的可视化工作台（地图视角 / 台账 / 季度追溯 / 多账号数据隔离）
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
│   └── rose-b.webp
├── _headers                    # 安全头与缓存策略（Cloudflare 解析，格式敏感）
├── .assetsignore               # 上传排除清单（.git / .wrangler / README 等）
├── robots.txt
└── README.md
```

> **`_headers` 格式陷阱**：Cloudflare 要求每个响应头都必须紧跟在**顶格的路径行**之后
> （路径行以 `/` 开头，响应头行缩进两个空格）。文件开头如果先写响应头、没写路径行，
> 部署会直接失败并报 `Expected a path before headers`。全局头要写成 `/*` 开头。

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

`_headers`（安全头 / 缓存）与 `.assetsignore`（上传排除）都放在**仓库根目录**即自动生效，
不需要额外配置。

绑定自定义域名：项目 → **Settings → Domains & Routes** → 添加域名并按提示改 DNS（Cloudflare 自动签发证书）。

### 3) 部署失败排查

构建日志里如果出现下面这类报错，是 `_headers` 格式问题（不是代码问题）：

```
Invalid _headers configuration:
Line 2: Expected a path before headers [code: 100324]
```

含义：有响应头没有紧跟在**顶格的路径行**后面。修法是把全局头（原本悬空的那些）
归到 `/*` 路径块下，路径行顶格、响应头行缩进两空格。

同时请确认 `.assetsignore` 生效——早期没有它时，`.git/` 整个目录会被当成静态资源上传
（日志里能看到 `+ /.git/HEAD` 之类的行），既浪费体积也可能暴露仓库历史。

### 4) 发布前检查清单

- [ ] 首页照片已换成你想要的版本（`assets/hero-photo.jpg`）
- [ ] 看板地图密钥已配置（见下一节；不配也能用，只是地图区域会提示不可用）
- [ ] 看板默认管理员密码已修改（登录后 → 账号菜单 → 修改密码）
- [ ] 确认 `.workbuddy/`、`hero-photo.png` 等本地文件没有被提交（`.gitignore` 已处理）

---

## 看板的地图密钥（重要）

沙箱预览环境会自动注入地图代理，**线上环境不会**。因此线上要显示真实底图，需要：

1. 到 [腾讯位置服务控制台](https://lbs.qq.com/) 申请一个 **WebService/JavaScript GL** 类型的 Key，
   并在 Key 的域名白名单里填上你的 Cloudflare 域名（如 `your-site.pages.dev` 和自有域名）；
2. 打开 `inspection-dashboard.html`，找到文件末尾的这两行：

```html
<!-- 线上部署：把 key 填进下面这行的引号里即可加载真实底图；留空则仅沙箱预览可用 -->
<script>window.TMAP_KEY = '';</script>
```

3. 把 Key 填进去（只改引号之间的内容），提交推送即可。

未配置 Key 时看板不会白屏：地图区域会显示「地图未能加载」的提示，**左侧客户列表、季度统计、录入与检索功能都照常可用**。

## 数据与安全说明

- **数据存在浏览器本地**（`localStorage`），不上传服务器。换电脑或换浏览器需要用看板里的「导出 / 导入数据」迁移。
- 多账号数据按用户名隔离存放（`inspection_board_v1::<用户名>`）；密码以加盐多轮 SHA-256 哈希保存。
- 纯前端方案的密码校验**不构成真实的安全边界**（前端代码对访客可见、数据也在本机），
  适合个人 / 小范围内部使用。若需要真实账号体系与跨设备同步，需接入云端数据库与鉴权服务。
- `robots.txt` 已阻止搜索引擎收录看板页面，但请勿把看板当作公开可访问的私密系统。

## 技术要点

- **零依赖零构建**：所有样式与脚本内联在两个 HTML 文件里，不需要 npm、不需要打包，CDN 直接托管。
- **动画**：玫瑰由脚本按参数生成（每朵独立定位、朝向、摇摆与开合节奏，后排花朵带景深虚化），
  配合飘落花瓣、闪星、金色浮尘与掠过花束的光扫；鼠标粒子场为 Canvas 2D 手写实现。
- **降级**：尊重 `prefers-reduced-motion`（减弱动画）；`?still=1` 静态模式；
- **无障碍**：语义化标签、可键盘操作的图片选择区、图片与图形的 `aria-label`。

## 许可

个人站点，未附带开源许可。除看板外的视觉与文案请勿直接商用转载。
