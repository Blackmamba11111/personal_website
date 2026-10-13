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
│   └── hero-photo.jpg          # 首页照片（可直接替换同名文件）
├── _headers                    # Cloudflare Pages 安全头与缓存策略
├── robots.txt
└── README.md
```

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

### 1) 推到 GitHub

仓库已初始化并完成首次提交。只需要：

```bash
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

> 提交作者用的是占位的 GitHub noreply 邮箱，不会暴露真实信息。
> 想换成自己的：`git config user.email "你的邮箱" && git commit --amend --reset-author`。

不想用命令行的话，也可以在 GitHub 新建空仓库后，用网页的 **Add file → Upload files** 上传这些文件（注意保留 `assets/` 目录层级）。

### 2) 接 Cloudflare Pages

1. 打开 Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**；
2. 选中刚才的仓库；
3. 构建设置里：
   - **Framework preset**：`None`
   - **Build command**：留空
   - **Build output directory**：`/`
4. 点 **Save and Deploy**。首次部署约 1 分钟，之后每次 `git push` 都会自动重新发布。

绑定自定义域名：Pages 项目 → **Custom domains** → 添加域名并按提示改 DNS 即可（Cloudflare 会自动签发证书）。
若域名也托管在 Cloudflare，通常是一键完成。

### 3) 发布前检查清单

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
