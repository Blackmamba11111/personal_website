# 客户巡检管理看板 · 内部移植交接说明

> 一句话：这是一套「按季度管理客户巡检」的多账号业务系统 —— 前端是一个零构建的单文件页面，
> 后端是 Cloudflare Worker + D1（SQLite）。本文档面向接手开发的同学，覆盖需求全貌、代码与演示入口、
> 数据与接口契约、本地跑通步骤、以及必须知道的坑。

| 项目 | 内容 |
| --- | --- |
| 演示（看板） | <https://web.aill.top/inspection-dashboard> |
| 演示（首页） | <https://web.aill.top> |
| 代码仓库 | <https://github.com/Blackmamba11111/personal_website> |
| 演示账号 | `admin`（口令线下单独提供；仓库与文档中不落任何口令） |
| 技术栈 | 原生 HTML/CSS/JS（单文件）+ Cloudflare Workers + D1 + 腾讯地图 GL JS |
| 代码体量 | 看板 206 KB / 省界数据 388 KB（独立缓存）/ Worker 380 行 |
| 自动化测试 | 7 套、353 项断言，`npm test` 全绿 |
| 仓库 HEAD | `git log -1`（含省界拆分与测试套件，本文档同一提交） |
| 线上版本 | `b62ea01` —— **比仓库旧**，功能一致，差异仅在省界数据是否内联（线上首屏更慢） |

> ⚠️ 两个交接前必须先处理的事：
> 1. 仓库目前是 **public**。内部平台建议先转私有，或整体迁到内部 Git 服务后再交接。
> 2. 演示环境用的是真实台账库。交接前建议导出备份、给接手方单独开账号，不要共用超管口令。

---

## 1. 业务背景与角色

现场巡检类项目的台账管理：一个账号负责一批客户，按季度考核「有没有按频率去过现场」。
原来的做法是 Excel + 人脑记，痛点是跨季度追溯难、换人接手对不上账、多人协作各存一份。

系统提供三种角色视角：

| 角色 | 典型使用者 | 能看到什么 |
| --- | --- | --- |
| 普通用户 | 一线巡检/客户经理 | 只有自己名下的客户与巡检记录 |
| 超级管理员 · 汇总视图 | 团队负责人 | 全部账号的台账，跨账号检索，**只读** |
| 超级管理员 · 切到某账号 | 团队负责人 | 以该账号身份录入，写入落到该账号台账（代录） |

规模参考：单账号数十到数百家客户、每年数千条巡检记录；当前实现为单库单表 JSON，量级再大需改表结构。

---

## 2. 完整需求清单

状态均为「已实现并上线」。括号内是实现要点，便于判断改动影响面。

### A. 巡检业务

| # | 需求 | 实现要点 |
| --- | --- | --- |
| A1 | 按季度查看巡检情况 | 默认本机当前季度；下拉为「近 8 个季度 ∪ 历史记录中出现过的季度」 |
| A2 | 已巡检突出、未巡检异色 | 红=未巡检 / 橙=部分完成 / 绿=达标，地图标记、客户卡片、详情徽标三处同色 |
| A3 | 独立的待办提醒窗口 | 可关闭面板，行内标「待补月份」，右侧标签显示缺几个月 |
| A4 | 巡检频率录入 | 每季度 1 次 / 一年 4 次 / 一年 12 次（按月考核） |
| A5 | 逐月进度呈现 | 卡片逐月进度条（已巡检 / 已到未巡检 / 未到），详情弹窗有月度明细 |
| A6 | 报表与待办导出 | CSV 导出；浏览器拦下载时降级为「可复制文本面板」 |
| A7 | 数据备份与迁移 | 整库 JSON 导出/导入；客户 CSV 批量导入 |
| A8 | 演示数据 | 一键恢复 14 家示例客户（操作前提示先备份） |

### B. 地图与区域

| # | 需求 | 实现要点 |
| --- | --- | --- |
| B1 | 省份轮廓圈出范围 | 34 个省级行政区真实边界，按区域着色 |
| B2 | 轮廓要精细 | 公开行政区划数据矢量化简，主体环 600~1100 点/省 |
| B3 | 飞地正确显示 | 嵌套拓扑（外环 + 洞环），北三县、天津境内河北飞地正确挖洞 |
| B4 | 区域可自定义 | 区域增删改、配色、任意省份组合；同省归属互斥并提示 |
| B5 | 地点搜索 | 在线检索 → 候选列表 + 地图标记 → 人工确认后写入 |
| B6 | 地图拾取坐标 | 地图点选写入表单；地图未就绪时明确提示而非静默失败 |
| B7 | 按省上浮省名 | 选中区域时每个所辖省份各自落标，落点取主体版图顶点均值（避开飞地空洞） |
| B8 | 标题跟随筛选 | 顶部副标题与浏览器标题联动「数据范围 + 区域筛选」 |
| B9 | 客户位置旁显示名称 | 独立标签层，同源碰撞自动让位，超 12 字截断 |
| B10 | 悬浮客户看巡检信息 | `hover` 事件弹信息窗 + 光晕，**不改变选中态、不移动视野** |

### C. 账号与权限

| # | 需求 | 实现要点 |
| --- | --- | --- |
| C1 | 登录页 | 用户名 + 密码；账号不存在与密码错误同一提示，防枚举 |
| C2 | 多账号数据隔离 | 库中按用户名各存一份台账；接口层再判一次「只能写自己那份」 |
| C3 | 用户管理页 | 创建 / 编辑 / 停用 / 删除 / 重置密码 / 角色切换 |
| C4 | 超管汇总视图 | 合并各账号台账，**只读**；可切到具体账号代录 |
| C5 | 只读双重守卫 | 界面禁用写操作 + 存储层再拦一道 |
| C6 | 角色安全 | 不能删当前账号；不能删除/停用/降级「最后一个启用的超管」 |
| C7 | 服务端会话 | 登录签发 Bearer 令牌（30 天），退出即删；改密踢掉其它设备 |
| C8 | 强制改密 | 初始/被重置口令带 `must_change`，登录后弹不可关闭的改密框 |
| C9 | 旧数据迁移 | 超管首次登录把本地旧账号与台账一次性迁入服务端（口令哈希沿用） |

### D. 客户主数据管理（独立的「客户管理」页）

| # | 需求 | 实现要点 |
| --- | --- | --- |
| D1 | 独立菜单 | 工具栏入口打开整页视图，不影响地图与卡片列表，可随时返回 |
| D2 | 看**所有**客户信息 | 按当前数据范围列出；超管汇总跨账号查看，多一列「所属账号」 |
| D3 | **不含巡检数据** | 只有档案字段：名称/区域/省市/地址/联系人/电话/坐标/频率 |
| D4 | 查 | 关键词命中名称、地址、联系人、电话、省市、区域任一字段；空态提示 |
| D5 | 增 | 复用既有客户表单（城市联动、地图拾取、地点搜索） |
| D6 | 改 | 行内编辑回填，名称与坐标沿用同一套必填与范围校验 |
| D7 | 删 | 二次确认，明确提示「连带删除该客户巡检记录且不可恢复」 |
| D8 | 权限 | 普通用户只见自己；超管汇总视图按钮禁用并给指引，切账号后可编辑 |

### E. 站点与部署

| # | 需求 | 实现要点 |
| --- | --- | --- |
| E1 | 首页 | 个人站点：粒子跟随、玫瑰素材、照片、功能入口（看板入口 + 预留位） |
| E2 | 404 | 与站点同风格的自定义错误页 |
| E3 | 自有域名 | `web.aill.top`，首页与看板均可访问 |
| E4 | 安全策略 | CSP（含地图三个必需域名）、nosniff、referrer-policy、permissions-policy |
| E5 | 缓存策略 | HTML 短缓存 + 后台刷新；`/assets/*` 长缓存 immutable |
| E6 | 服务端接口 | `/api/*` 走 Worker，其余走静态资源，未匹配回 404.html |

---

## 3. 核心业务口径（**必须原样继承，改错会直接导致考核结论错误**）

| 巡检频率 | 考核方式 | 季度目标 |
| --- | --- | --- |
| 每季度 1 次 | 按季度 | 1 个月 |
| 一年 4 次 | 按季度 | 1 个月 |
| 一年 12 次 | **按月** | 3 个月 |

达标判定：

- **分母** = 本季度「已到月份」：往季 3 个月；当季只算到当前月份。未到的月份不算欠账，避免季度首日全表爆红。
- **分子** = 其中有巡检记录的**月份数**（同一个月去 3 次只算 1 个月）。
- 分子 0 → 未巡检（红）；0 < 分子 < 目标 → 部分完成（橙）；分子 ≥ 目标 → 达标（绿）。

一句话：**看「哪几个月去过」，不看「一共去了几次」。**

对应实现：`statusOf(c, qk)`（看板 1398 行附近），测试 `tests/test-monthly.js`（41 项）专门守这套口径。

---

## 4. 技术架构

```
浏览器                           Cloudflare 边缘                    存储
┌──────────────────────┐        ┌───────────────────────┐        ┌──────────────┐
│ inspection-dashboard │  /api  │ worker/index.js       │  SQL   │ D1           │
│  · 单文件 206 KB      │ ─────► │  · 登录/会话/改密      │ ─────► │ users        │
│  · localStorage 镜像  │        │  · 台账读写（权限判定） │        │ ledgers      │
│  · 800ms 防抖推送     │ ◄───── │  · 用户管理（仅超管）   │ ◄───── │ sessions     │
│  · 90s 轮询 + 回页面  │  JSON  │  · 安全响应头注入      │        └──────────────┘
└──────────────────────┘        └───────────────────────┘
         │  其余路径                      │ ASSETS 绑定
         └──────────────► 静态资源（HTML / assets/* / 404）
```

**关键设计：服务端是唯一权威数据源，浏览器只是镜像缓存。**
写入 = 立即写本地镜像（断网可继续录入）+ 800ms 防抖 `PUT /api/ledger`；读取 = 登录/刷新拉全量快照 + 90 秒轮询 + 切回页面时拉取。因此换电脑登录同一账号看到同一份数据，代价是最长约 90 秒的非实时延迟。

### 目录结构与职责

```
.
├── inspection-dashboard.html   # 看板全部前端逻辑（单文件，4324 行 HTML+CSS+JS）
├── assets/provinces.js         # 34 省轮廓 + 497 项城市候选（异步加载，?v= 版本化）
├── worker/
│   ├── index.js                # 全部后端：路由、鉴权、台账、用户管理、安全头
│   └── schema.sql              # D1 建表 + 初始超管（幂等）
├── wrangler.jsonc              # Workers 配置（静态资源 + D1 绑定 + 全量先过 Worker）
├── index.html                  # 个人首页（与看板无依赖，可整体剥离）
├── tests/                      # 7 套 jsdom 回归测试 + 服务端内存桩
└── 404.html / robots.txt / .assetsignore
```

**最小移植集**（只要看板，不要个人首页）：
`inspection-dashboard.html` + `assets/provinces.js` + `worker/` + `wrangler.jsonc` + `404.html` + `tests/`。

### 看板关键函数索引（行号为当前 HEAD，重构后会漂移）

| 关注点 | 函数 |
| --- | --- |
| 启动与登录 | `boot()` 4276 · `signIn()` 4219 · `hashPwd()` 3331 |
| 接口与同步 | `api()` 3357 · `pushLedger()` 3513 · `refreshFromServer()` 3538 · `load()` 3606 |
| 业务判定 | `statusOf()` 1398（季度/月度达标） |
| 省界数据 | `loadProvinces()` 1133 · `installProvinces()` 1100 · `migrate()` 1326 |
| 地图 | `loadTMap()` 1754 · `initMap()` 1783 · `buildRegionLayers()` 2000 · `renderMarkers()` 2107 |
| 客户与客户管理页 | `openCustModal()` 2652 · `openCustsPage()` 3796 · `renderCustsPage()` 3839 |
| 汇总渲染 | `save()` 1378 · `renderAll()` 3041 |

---

## 5. 数据模型

### 5.1 D1 三张表（`worker/schema.sql`）

| 表 | 字段 | 说明 |
| --- | --- | --- |
| `users` | username(PK), name, role(`admin`/`user`), status(`active`/`disabled`), note, salt, hash, must_change, created_at, last_login | 账号与口令哈希 |
| `ledgers` | username(PK), data(JSON TEXT), updated_at, updated_by | 一人一份台账，`data` 为整份 JSON |
| `sessions` | token(PK), username, created_at, expires_at | Bearer 令牌，30 天 |

### 5.2 台账 JSON 结构（`ledgers.data`）

```jsonc
{
  "regions": [                                   // 自定义区域
    { "id": "r-hb", "name": "河北", "color": "#2563EB", "provinces": ["河北"] }
  ],
  "customers": [                                 // 客户档案
    {
      "id": "c01", "name": "农行北京数据中心",
      "regionId": "r-bj", "province": "北京", "city": "海淀区",
      "addr": "北京市海淀区中关村南大街甲18号",
      "lng": 116.31286, "lat": 39.97654,         // GCJ-02，与腾讯地图一致
      "freq": "y12",                             // quarter | y4 | y12
      "contact": "王经理", "phone": "", "note": "核心机房，需提前报备",
      "hasCoords": true
    }
  ],
  "visits": [                                    // 巡检记录（明细，不预设上限）
    { "id": "v01", "customerId": "c01", "date": "2026-10-08",
      "by": "潘超", "note": "机房环境温湿度正常，核心交换机无异常告警" }
  ]
}
```

### 5.3 浏览器存储键（均为镜像，非权威）

| 键 | 内容 |
| --- | --- |
| `inspection_board_token_v1` | 会话令牌 |
| `inspection_board_v1::<用户名>` | 该账号台账镜像 |
| `inspection_board_users_v1` | 账号列表镜像（界面渲染 + 旧数据迁移来源） |
| `inspection_board_pref_v1::<范围>` | 界面偏好（自动提醒开关等，纯本地） |

---

## 6. 接口契约（`/api/*`）

统一约定：请求/响应均为 JSON；成功 `{"ok":true,"data":...}`；失败 `{"ok":false,"error":"中文提示"}`，
状态码 400/401/403/404/405/500。除登录外均需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 权限 | 入参 | 出参 data |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/login` | 公开 | `{username, password}` | `{user, users[], ledgers{}, admin, token}` |
| GET | `/api/auth/me` | 登录 | — | 同上（不含 token） |
| POST | `/api/auth/logout` | 登录 | — | `null`（删除当前令牌） |
| POST | `/api/auth/password` | 登录 | `{oldPassword, newPassword}` | `null`（踢掉其它会话） |
| GET | `/api/ledger` | 登录 | — | 同 `/auth/me` 的快照 |
| PUT | `/api/ledger` | 登录 | `{scope, data:{regions,customers,visits}}` | `{scope, updatedAt}` |
| GET | `/api/users` | 超管 | — | `{users[]}` |
| POST | `/api/users` | 超管 | `{username, name, role, password}` 或 `{salt, hash}`（迁移） | `{user}` |
| PATCH | `/api/users/:username` | 超管 | `{name?, role?, status?, note?, password?}` | `{user}` |
| DELETE | `/api/users/:username` | 超管 | — | `null`（连带删台账与会话） |

规则要点：
- `username` 3–32 位 `[A-Za-z0-9_.-]`，入库前转小写；口令 ≥ 6 位。
- 普通用户 PUT 只能写 `scope === 自己`；超管可指定任意已存在账号。
- 新建/重置口令的账号 `must_change = 1`（前端强制改密）。
- 至少保留一个启用的超管，否则拒绝删除/停用/降级。

---

## 7. 接手必读：九个坑（都踩过，别再踩）

1. **不要新增 `_headers`。** Workers 静态资源永不更新「已存在的」`_headers`，改了线上仍旧策略，曾导致地图样式域名被拦、底图全灰。CSP 走页面 `meta`，其余安全头由 Worker 注入。
2. **`assets.run_worker_first` 必须是 `true`。** 写成路径数组时只有匹配路径进 Worker，页面类响应拿不到安全头。
3. **ETag / 304 在 Workers 静态资源上走不通。** 边缘会剥离 Worker 设的 `ETag`，只能靠 `max-age + stale-while-revalidate`。
4. **层叠刻度不要乱设。** 主内容 100 → 内容页 `.page` 150 → 浮层 `.high` 320 → toast 400。凡可能从「客户管理 / 用户管理」内部打开的弹窗，容器必须带 `high`，否则被整屏页面盖住（表象是「点了没反应，返回后才出现」）。
5. **口令算法有三处实现，改一处必须同步三处**：前端 `hashPwd()`、`worker/index.js` 的 `hashPwd()`、`tests/test-helpers.js`。算法为 `salt|pwd` 起手、400 轮 `SHA-256`。
6. **省界数据是异步加载的。** `migrate()` 里用 `PROV_MAP` 过滤 `region.provinces` 前必须判 `PROVINCES.length`，否则数据未到时会清空省份归属并写回服务端。改 `assets/provinces.js` 内容必须同步提升 `PROV_SRC` 与 `<link rel=preload>` 两处 `?v=`。
7. **地图 SDK 必须异步、带超时。** 同步加载时地图域名一慢就阻塞整页解析，登录框永不出现；现为 15 秒超时 + 失败提示。
8. **腾讯地图 Key 依赖域名白名单。** 换域名要到腾讯位置服务控制台加白，否则底图空白；WebGL 被关闭也会空白，页面内有「检测显卡支持」自查按钮。
9. **部署后不要立刻断言失败。** 边缘缓存 1–2 分钟，刚发布可能仍命中旧副本；无头浏览器验证大页面要轮询 `document.readyState === 'complete'`，固定 sleep 会误判。

---

## 8. 本地跑起来

前置：Node ≥ 20、一个 Cloudflare 账号（免费版足够）、一个腾讯地图 Key（Web 端）。

```bash
git clone https://github.com/Blackmamba11111/personal_website.git
cd personal_website
npm install

# 1) 跑测试（无需任何云资源，jsdom + 内置服务端桩）
npm test

# 2) 本地起服务（Wrangler 会拉起本地 D1）
npx wrangler d1 execute inspection_ledger --local --file=./worker/schema.sql
npx wrangler dev          # 默认 http://127.0.0.1:8787

# 3) 首次部署（换你自己的账号时）
npx wrangler d1 create inspection_ledger          # 记下返回的 database_id，填进 wrangler.jsonc
npx wrangler d1 execute inspection_ledger --remote --file=./worker/schema.sql
npx wrangler deploy
```

- 部署需要凭据：非交互环境用 `export CLOUDFLARE_API_TOKEN=...`（Token 需 `Workers Scripts: Edit` + `D1: Edit`）。
- 初始超管为 `admin` / `admin888`，`must_change=1`，登录后会强制改密——**首次上线务必先改**。
- 地图 Key 写在 `inspection-dashboard.html` 的 `window.TMAP_KEY`（浏览器公开密钥，安全性靠域名白名单）。

---

## 9. 测试体系

```bash
npm test                 # 全部套件
npm run test:board       # 单跑某一套
```

| 套件 | 断言数 | 覆盖 |
| --- | --- | --- |
| `test-board.js` | 52 | 季度切换、达标判定、客户/巡检增删改、导出、城市候选 |
| `test-board-edge.js` | 9 | 空数据、极端频率、无坐标客户 |
| `test-monthly.js` | 41 | 逐月覆盖、当月未到、同月多次只算一次 |
| `test-auth.js` | 72 | 登录门禁、停用账号、角色边界、汇总只读、数据隔离 |
| `test-map.js` | 23 | 带洞结构、标记数量、切换与登出时图层重建 |
| `test-custs.js` | 75 | 客户管理页字段（含「不含巡检数据」反证）、搜索、CRUD、层叠守卫 |
| `test-home.js` | 81 | 首页结构/动效/降级、部署产物、省界拆分与版本号一致性 |
| **合计** | **353** | 约 15 秒跑完 |

测试实现要点：
- JSDOM `runScripts: 'dangerously'` 直接执行页面内联脚本，**不联网**；`tests/test-helpers-server.js` 注入内存版 `/api/*`（与 Worker 同算法、同权限判定）。
- 省界数据拆到 `assets/provinces.js` 后，JSDOM 不加载外部脚本：`test-helpers.js` 会在页面 `<!-- __PROVINCES_INLINE__ -->` 标记处把该文件内联进来。**标记被删会直接抛错**。
- 真实浏览器验证需另做（CDP/手工）：JSDOM 不算真实层叠、不渲染 WebGL。

---

## 10. 已知限制与技术债

| 项 | 现状 | 影响 |
| --- | --- | --- |
| 单文件前端 | 4324 行 HTML+CSS+JS 全在 `inspection-dashboard.html` | 无模块化、无构建、多人并行改动易冲突 |
| 同步非实时 | 写入即推 + 90s 轮询 + 切回页面 | 他端改动最长约 90 秒可见 |
| 台账整包 JSON | 一次改动写整份台账 | 单账号数据量大后写放大明显 |
| 账号体系最小实现 | 无找回密码、无失败锁定、无审计日志 | 对外扩员前必须补 |
| Cloudflare 单点 | 静态资源、接口、数据库都在 CF | 平台不可用时只能读本地镜像 |
| 大陆访问质量 | 免费版常调度到 LAX，跨洋 RTT 高 | 首屏仍可能数秒；已通过拆包与缓存缓解 |
| 省界数据 388 KB | 已紧凑编码，br 后 171 KB | 首次加载的主要成本，可再简化但会掉精度 |

---

## 11. 内部部署实例（2026-10-20 已完成）

平台已按第 11 节 P0-4 的「替换 Worker 形态」思路完成一次内部部署，**接口契约与前端零改动**：

| 项目 | 内容 |
| --- | --- |
| 地址 | **`https://10.1.114.115/inspection-dashboard`**（首页 `/`；http 80 仅跳转） |
| 形态 | Docker（node:24-bookworm-slim）+ Node 原生 https 服务端（TLS 进程内终止）+ SQLite（Node 内置 `node:sqlite`，WAL） |
| 证书 | 内部 CA 自签（SAN 含 IP），首访浏览器需「继续前往」或安装 `certs/ca.crt` 到受信任根 |
| 位置 | `/opt/inspection`（数据 `data/inspection.db`，备份 `backup/`，cron 每天 02:30 保留 7 份） |
| 初始账号 | `admin / admin888`，首登强制改密 |
| 数据 | 平台自带演示数据（28 家客户示例），非真实台账 |
| 运维手册 | `deploy/internal/DEPLOY.md`（同机 `/opt/inspection/DEPLOY.md`） |

部署形态源码在仓库 `deploy/internal/`：`server.js`（与 Worker 版接口一一对应）、`Dockerfile`、`docker-compose.yml`。
**坑**：该内网出口对 Cloudflare 网段（npmjs.org / nodejs.org）不可达，因此服务端刻意零 npm 依赖；
引入第三方包时走 `registry.npmmirror.com` 且原生模块需另配头文件镜像。地图 Key 在该地址下实测可用。

## 12. 内部化改造建议（按优先级）

**P0 · 交接前/上线前必做**

1. **仓库转私有或迁内网 Git**：当前 public，源码与业务字段对外可见。
2. **口令与密钥治理**：改掉演示超管口令；为接手方单独开账号；腾讯地图 Key 按新域名重配白名单；Cloudflare Token 一人一份、最小权限。
3. **数据备份与脱敏**：`wrangler d1 export` 导一份现网数据做基线；演示环境建议灌示例数据而非真实客户信息。
4. **确认部署形态**：内部是否能访问 Cloudflare。若不能，Worker + D1 需替换为 Node/Java 服务 + MySQL/PG；**接口契约（第 6 节）与台账 JSON（第 5.2 节）可原样保留**，前端只需改 `api()` 的 baseURL 与鉴权头。

**P1 · 第一个迭代内**

5. **前后端拆分**：把 `inspection-dashboard.html` 拆成 `index.html + app.js + styles.css + 模块（auth/map/ledger/custs）`，引入 Vite 或 esbuild；`assets/provinces.js` 保持独立长缓存。
6. **CI**：push 即跑 `npm test`；部署走流水线，禁止本地直传生产。
7. **接口加审计**：`ledgers.updated_by` 已有，但缺操作流水（谁在何时改了哪条客户/巡检），代录场景尤其需要。
8. **台账改结构化表**：`customers` / `visits` 落到独立表，按 `username` 建索引，去掉整包写入。

**P2 · 视规模再做**

9. 实时协作（WebSocket / Durable Objects 或轮询改 SSE）。
10. 权限细化（只读角色、区域级数据权限、审批流）。
11. 移动端适配（现场录入拍照/定位）与离线 PWA。
12. 统计报表（按区域/客户/人/季度的完成率趋势）。

---

## 13. 交接清单

- [ ] 代码仓库权限（或内网仓库地址）
- [ ] 演示地址与**独立**演示账号（不要给超管口令）
- [ ] 腾讯地图 Key 与域名白名单
- [ ] Cloudflare 账号 / D1 库 `inspection_ledger` / 部署 Token
- [ ] 现网数据导出备份（JSON + `wrangler d1 export`）
- [ ] 域名解析与证书归属说明
- [ ] 本文件 + `README.md` + `tests/`

---

## 附录 · 需求演进（摘要）

系统在 2026-10-12 ~ 10-19 之间迭代 26 轮，主要阶段：

1. **单机版**（1–7 轮）：季度看板 → 真实省界 → 飞地挖洞 → 区域自定义。
2. **多租户**（8–13 轮）：登录页、用户管理、超管汇总、按账号隔离（当时存 localStorage）。
3. **上线排障**（14–18 轮）：`_headers` 坑、地图 SDK 阻塞、CSP 白名单、区域标题联动。
4. **服务端化**（19–22 轮）：Worker + D1、Bearer 会话、跨设备、客户名称标签与悬浮信息。
5. **客户主数据**（23–25 轮）：独立客户管理页、弹窗层叠修复、34 省 497 城市候选。
6. **性能**（26 轮）：省界数据拆分 + 异步加载 + immutable 缓存，主文档 588 KB → 206 KB。

更细的「每轮需求原话 → 根因 → 交付结果」记录在项目内部档案里（含个人信息，未随仓库公开），
需要时向原负责人索取。
