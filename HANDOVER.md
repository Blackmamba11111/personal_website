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
| 自动化测试 | 19 套、1215 项断言，`npm test` 全绿 |
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
| A4 | 巡检频率录入 | 一年 2 次（按半年） / 一年 4 次（按季度） / 一年 12 次（按月考核） |
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
| C10 | 本地 / 远程用户 | 账号分「本地用户」与「远程用户」；远程用户的口令交给 RADIUS / TACACS+ / LDAP 校验，本站不存密码 |
| C11 | 认证服务器管理 | 用户管理页内「认证服务器」页：增删改查 + 启用停用 + 真实「测试连接」（未保存的配置也能测） |
| C12 | 读写 / 只读权限 | 每个账号可设 `perm=rw/ro`；只读账号界面拦截 + 服务端 403 双重守卫（与汇总视图的只读是两套语义） |
| C13 | 批量编辑账号配置 | 用户列表勾选多个账号后批量应用：区域展示名称（`{username}` 占位符）/ 账号类型与认证服务器 / 角色 / 权限 / 启用状态 / 登录超时 / 备注 / 敏感字段可见性；逐账号 PATCH，保护最后一个超管与当前账号 |
| C14 | 敏感字段按用户隐藏 | `users.hide_sensitive`：开启后该账号看到的客户「联系人 / 电话」一律全隐为 `****`（服务端下发即替换，列表/详情/导出/本地镜像都拿不到明文，也不渲染眼睛图标）；写入时对已存在客户回填库内原值，防止占位串写回。详细地址不属于敏感项，任何账号都完整展示 |
| C15 | 敏感字段逐条查看 | 未开启隐藏的账号：联系人与电话默认全隐 `****`，每条带眼睛图标（SVG），点某条只展开那条明文、再点收起，互不影响、仅本会话有效（换账号/重登录清空）；CSV 导出对有权限账号输出明文、无权限账号仍是 `****` |

### D. 客户主数据管理（独立的「客户管理」页）

| # | 需求 | 实现要点 |
| --- | --- | --- |
| D1 | 独立菜单 | 工具栏入口打开整页视图，不影响地图与卡片列表，可随时返回 |
| D2 | 看**所有**客户信息 | 按当前数据范围列出；超管汇总跨账号查看，多一列「所属账号」；汇总只统计数据所有者账号——借用共享数据的成员账号跳过，同一份数据不重复出现（区域/客户/地图同口径） |
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

### F. CRM 台账关联（2026-11-05，询盘云 / 销售易）

| # | 需求 | 实现要点 |
| --- | --- | --- |
| F1 | 超管「CRM 台账关联」页 | 配账号密码 + 检索间隔（1–168 小时，默认 12）、测试连通性、立即检索；**立即检索带真实进度条**（阶段 + 已完成 x/N + 当前客户 + 已用时长，完成 5 秒后收起）；按台账客户逐个显示获取状态（成功/未匹配）与维保到期 |
| F2 | 客户详情两块 | 「客户现网信息」：项目名称、客户名称、客户级别、行业、战区/部门、项目所有人、项目技术负责人（=维护人A）、维护人B + 硬件逐台（序列号/型号/服务时间/版本）+ 维保三态；「产品与技术信息」：主要使用功能、总采购数量/GSLB台数、高可靠架构、操作系统版本、现网软件版本 |
| F4 | 项目技术负责人 | 直接用 CRM 的 `维护人A`（中文名），不改写、不映射 |
| F5 | 我负责的项目 | 客户列表搜索区「全部项目 / 我负责的项目」切换；命中条件 = 登录用户 `name_cn` 与商机 `维护人A` 全等（拼音登录名靠管理员填中文名转译） |
| F6 | 按用户控制可见性 | 用户管理里逐账号开关，**默认关闭**；关闭只隐藏「别人负责的项目」——**「我负责的项目」对全员开放**（维护人A = 本人中文名即下发） |
| F7 | 列表维保徽标 | 与「未巡检」徽标并列，三态：维保全部到期 / 部分到期 / 未到期；未匹配客户不显示 |
| F8 | 区域统计（2026-11-06） | **独立页面**（`statView`）：CRM 页头部「区域统计」按钮进入，返回回 CRM。超管选**战区**（如金融行业部）→ 拉该战区下**全部商机**（不限台账客户）→ 逐项目拉维保 → 以项目为主体输出明细（项目/客户/部门/销售/合同日期/合同名称/序列号/产品/型号/维保起止）→ 按**产品型号汇总台数**（序列号去重，可下钻）→ 导出明细/汇总 CSV。明细支持**项目名称 / 客户名称 / 销售 / 型号**四项关键词筛选（实时过滤，可与型号下钻叠加，导出走筛选结果） |
| F9 | 区域统计按账号授权（2026-11-06） | `users.stat_visible`（默认 0）。超管恒可见；被授权账号在账号菜单看到「区域统计」入口，点开直达统计页、返回回看板。**只读**：能看缓存/切 tab/下钻/导出，不能触发检索（前端禁用 + 服务端 `/api/crm/stat/run` 403）。检索结果全区共用一份缓存 |
| F10 | 检索即可停 + 数字只来自实测（2026-11-06） | 战区下拉**只列名称**，不再把上次统计数写进选项（避免被当成系统预置值）；「多少项目 / 多少设备」一律由「检索」以区域名称为条件实时查 CRM 得出，结果显示在结果区与进度条（`共 N 个项目 · 已发现 M 台设备`）。进度条旁新增**「停止」**：协作式中断（`opts.shouldStop` → 服务端 `crmStatCancel`，`POST /api/crm/stat/stop`，仅超管），当前项目拉完即收尾；已扫到的部分**落库保留**并标 `partial / scanned / total`，页面显示「部分结果（已扫 n/m 个项目）」，仍可查看与导出。商机清单尚未扫完就停止则不产生结果 |
| G1 | 视觉重设计（2026-11-09） | 品牌蓝绿双色（取自 ZDNS logo）重建设计系统：8 档字号（基准仍 13px）、4 级阴影、6 档圆角、4px 间距刻度；字重统一 400/500/600/700（中文无 650 档，会合成发虚）；数字统一 `tabular-nums`；`focus-visible` 焦点环、`prefers-reduced-motion` 降级、细滚动条。组件统一：徽标五套语义色收敛、表格粘性表头 + 悬停、弹窗 sh-4 + 入场动效、顶栏按主次分组（低频动作 `.btn.quiet`） |
| G2 | 总览页（2026-11-09） | 新增 `overviewView`（顶栏「看板 / 总览」分段切换）：4 张 KPI 大卡（客户总数 / 达标率含三段构成条 / 待处理含剩余天数 / 维保风险）、区域覆盖条形（达标/部分/未达标三段）、优先处理待办（点击下钻客户详情）、最近巡检 8 条。数据全部复用内存 `DB` 与 `statusOf`，不额外请求 |
| G3 | 详情分段导航（2026-11-09） | 客户详情弹窗在头部与滚动区之间加固定锚点行（概览 / 维保与现网 / 登记巡检 / 历史记录），点击平滑滚动；**不改动原区块 DOM**，避免破坏既有渲染与测试 |
| G4 | 精密仪表视觉方向（2026-11-09） | 在 G1 之上做第二遍系统性美化，方向定为「精密仪表」：底色压深一档（`--bg #E9EDF3`）让白面板立起来；语义三色压到同一明度带（ok/warn/danger 的 ink 分别为 `#0A6B4C/#8A5906/#99201F`）；阴影改为短距离贴地（去掉发散柔光）；圆角整体收紧一档（卡片 7px、按钮 5px）；**数字/编号/日期/表头一律走 `--font-mono`**（中文仍用系统黑体，内网无法依赖 webfont）——等宽数字是本方向的身份标识；背景 16px 极淡经纬网格；KPI 卡加四角定位刻线；进度条改直角 + 10% 刻度；`.badge.wb-*` 改「方点 + 中性底」与巡检徽标分层；表头改 10px 等宽大写；详情导航改下划线页签 |
| G5 | 顶栏收纳 + 总览重排（2026-11-09） | 低频动作（区域设置 / 客户管理 / 返回首页）收进「更多」弹层（`#morePop`，`position:fixed` + 运行时算坐标——topbar 有 `overflow-x:auto`，绝对定位会被裁剪；点外部 / Esc / resize / 点条目自动收起）。**菜单内保留原 `#btnRegions` `#btnCusts` id**，既有测试与逻辑不受影响。总览页改「三行 + 末行自适应」：`ov-card-fill{flex:1}` 吃掉剩余高度，最近巡检改单列 8 行，区域行 `space-evenly` 分布，解决底部大片空白与卡片下边缘不齐 |
| G6 | 登录页控制台化（2026-11-09） | 左侧改石墨黑控制台面板（24px 网格 + 顶部品牌渐变线 + 三行等宽读数：系统状态 / 数据来源 / 底图坐标系），右侧表单标签改等宽小字；整站唯一的大面积深色只出现在这里，用于框住「系统身份」 |

**服务端必须自己登录 CRM**（不能依赖任何人的浏览器会话）：账号密码存 `crm_config`，会话存 `crm_config.session`，失效自动重登一次；内网用 `setInterval`、公网用 Cron Trigger 各自驱动。


---

## 3. 核心业务口径（**必须原样继承，改错会直接导致考核结论错误**）

| 巡检频率 | 考核方式 | 季度目标 |
| --- | --- | --- |
| 一年 2 次（`y2`，2026-11-04 新增） | **按半年**：上半年 1–6 月 / 下半年 7–12 月各 1 次 | 半个窗口 1 次 |
| 每季度 1 次 | 按季度 | 1 个月 |
| 一年 4 次 | 按季度 | 1 个月 |
| 一年 12 次 | **按月** | 3 个月 |

`y2` 的窗口由**当前所选季度**决定：Q1/Q2 看上半年、Q3/Q4 看下半年；同一个半年内切季度，结论不变。
半年判定同样走「分组覆盖」逻辑（`windowVisits()` 是统一入口），`result=other` 不计入。

达标判定：

- **分母** = 本季度「已到月份」：往季 3 个月；当季只算到当前月份。未到的月份不算欠账，避免季度首日全表爆红。
- **分子** = 其中有巡检记录的**月份数**（同一个月去 3 次只算 1 个月）。
- 分子 0 → 未巡检（红）；0 < 分子 < 目标 → 部分完成（橙）；分子 ≥ 目标 → 达标（绿）。

一句话：**看「哪几个月去过」，不看「一共去了几次」。**

### 巡检方式与巡检结果（2026-10-21 新增）

| 字段 | 取值 | 是否计入次数 |
| --- | --- | --- |
| `mode` 巡检方式 | `onsite` 现场 / `remote` 远程 | 不影响计数 |
| `result` 巡检结果 | `ok` 正常 / `issue` 异常 / `other` 其他（未巡检） | **`other` 不计入**季度次数与年度累计，也不参与达标判定 |

判定入口唯一：`isCountedVisit(v)`（看板约 1325 行），`visitsInQuarter` / `visitsInYear` 都经它过滤；
历史记录没有 `mode`/`result` 时视为有效巡检（向后兼容），时间线不显示标签。

附件：一条巡检记录可带多个附件（图片/PDF/Office/文本/压缩包），文件独立存储、记录里只存
`{id,name,mime,size,url}`；图片与 PDF 可在看板内直接预览，其他类型给下载。删除记录/客户时
一并调用 `DELETE /api/attach/:id` 清理。

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
| CRM 展示 | `refreshCrmData()` 5569 · `crmMatchOf()` 5582 · `warrantyBadgeOf()` 5588 · `isMyProject()` 5597 · `openCrmPage()` 5961 |

---

## 5. 数据模型

### 5.1 D1 四张表（`worker/schema.sql`）

| 表 | 字段 | 说明 |
| --- | --- | --- |
| `users` | username(PK), name, role(`admin`/`user`), status(`active`/`disabled`), note, salt, hash, must_change, created_at, last_login, source(`local`/`radius`/`tacacs`/`ldap`), perm(`rw`/`ro`), server_id, name_cn, crm_visible, stat_visible | 账号、口令来源与数据权限；远程账号的 salt/hash 为空串。`name_cn` 是中文姓名（「我负责的项目」按它比对维护人A）；`crm_visible` 控制能否看 CRM 现网信息，默认 `0`；`stat_visible` 控制能否查看区域统计页（只读），默认 `0` |
| `auth_servers` | id(PK, `srv`+10 位 hex), name, type, host, port, enabled, cfg(JSON), created_at, updated_at | 远程认证服务器；`cfg.secret` 只写不回显 |
| `ledgers` | username(PK), data(JSON TEXT), updated_at, updated_by | 一人一份台账，`data` 为整份 JSON |
| `sessions` | token(PK), username, created_at, expires_at | Bearer 令牌，30 天 |
| `attachments` | id(PK, 24 位随机 hex), name, mime, size, owner, created_at, ext(内网版), data(Cloudflare 版) | 巡检附件；Cloudflare 版把文件 base64 存 `data`（D1 单行上限 2MB → 单文件 1MB）；内网版只存元数据，文件落 `DATA_DIR/uploads/<id><ext>`，单文件上限 100MB（2026-11-03 起，`MAX_BODY=200MB` 承接 base64 膨胀）。**`ext` 存的是按文件头嗅探出的真实扩展名，不能用文件名后缀推断**——前端会把图片统一重编码成 JPEG（文件名仍是 `.png`），只按名字找文件会 404 |
| `crm_config` | k(PK), v(JSON) | `k='main'` 存 CRM 登录账号/密码/检索间隔/上轮结果/会话快照（密码只写不回显）；`k='progress'` 仅公网用于落检索进度（跨 isolate 兜底） |
| `crm_matches` | customer_name(PK), status(`ok`/`miss`), record_id, level(1/2), multi, data(JSON), updated_at | 每个台账客户一条 CRM 快照，`data` 存 `{opp, maintenance, warranty, error}` |

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
      "freq": "y12",                             // y2（半年） | y4（季度） | y12（按月）
      "contact": "王经理", "phone": "", "note": "核心机房，需提前报备",
      "hasCoords": true,
      "units": [                                 // 可选：巡检分组（客户内部分组，叫法自由，未建分组=走整体口径）
        { "id": "u01", "name": "核心网络组", "owner": "张三", "note": "" }
      ]
    }
  ],
  "visits": [                                    // 巡检记录（明细，不预设上限）
    { "id": "v01", "customerId": "c01", "date": "2026-10-08",
      "by": "潘超", "note": "机房环境温湿度正常，核心交换机无异常告警",
      "mode": "onsite",                          // onsite 现场 | remote 远程（旧数据缺省为未填）
      "result": "ok",                            // ok 正常 | issue 异常 | other 其他（未巡检）
      "unitIds": ["u01"],                        // 可选：本次巡到的分组 id；空数组/缺省 = 整体巡检（视为覆盖全部分组）
      "atts": [                                  // 附件引用（文件本身不进 JSON）
        { "id": "9f2c…", "name": "机房照片.jpg", "mime": "image/jpeg",
          "size": 182344, "url": "/api/attach/9f2c…" }
      ] }
  ]
}
```

**巡检分组完成度口径（2026-11-03 新增）**：客户建了 `units` 后，完成度按考核窗口（季度）逐分组判定——每
个分组窗口内至少有一条有效巡检（result≠other 且 unitIds 命中或整体巡检）才算该组完成；**全部分组完成客户
才算达标**。看板徽标/客户列表/提醒列表/CSV 导出均为三态：已完成、部分完成 n/m 组、未巡检 0/m 组。
y12（按月考核）× 分组：当月**全部分组**都被覆盖才算该月达标。删除分组后客户的 visits 里残留 unitIds 不影响
判定（按现存 units 归集）。

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
| POST | `/api/auth/login` | 公开 | `{username, password}` | `{user, users[], ledgers{}, admin, canWrite, attachMax, authServers[]}` |
| GET | `/api/auth/me` | 登录 | — | 同上（不含 token） |
| POST | `/api/auth/logout` | 登录 | — | `null`（删除当前令牌） |
| POST | `/api/auth/password` | 登录 | `{oldPassword, newPassword}` | `null`（踢掉其它会话；远程账号拒绝） |
| GET | `/api/ledger` | 登录 | — | 同 `/auth/me` 的快照 |
| PUT | `/api/ledger` | 登录（读写） | `{scope, data:{regions,customers,visits}}` | `{scope, updatedAt}`；只读账号 403 |
| GET | `/api/users` | 超管 | — | `{users[]}`（含 `source/perm/serverId/serverName`） |
| POST | `/api/users` | 超管 | `{username, name, role, perm, serverId?, password?, data?}` 或 `{salt, hash}`（迁移） | `{user}` |
| PATCH | `/api/users/:username` | 超管 | `{name?, role?, status?, note?, perm?, serverId?, password?}` | `{user}` |
| DELETE | `/api/users/:username` | 超管 | — | `null`（连带删台账与会话） |
| GET | `/api/auth-servers` | 超管 | — | `{servers[]}`（`cfg.secret` 不回传，只给 `hasSecret`） |
| POST | `/api/auth-servers` | 超管 | `{name, type, host, port, enabled, cfg}` | `{server}` |
| PATCH | `/api/auth-servers/:id` | 超管 | 同上（`cfg.secret` 留空=不修改） | `{server}` |
| DELETE | `/api/auth-servers/:id` | 超管 | — | `null`（仍有账号绑定时 400） |
| POST | `/api/auth-servers/test` | 超管 | `{id?, type, host, port, cfg, username, password}` | `{ok, code, message}` |
| GET/HEAD | `/api/photo/current` | 公开 | — | 二进制图片（`no-cache` + ETag；无图 404） |
| POST | `/api/photo` | 公开（同源） | `{data:"data:image/(jpeg\|png\|webp);base64,…"}` | `{url, size, ext, at}` |
| DELETE | `/api/photo` | 公开（同源） | — | `{removed:true\|false}` |
| POST | `/api/attach` | 登录（读写） | `{name, mime, data:base64}` | `{id, name, mime, size, url}` |
| GET/HEAD | `/api/attach/:id` | 公开（id 不可猜） | — | 二进制附件；图片/PDF/文本 `inline`，其余 `attachment` |
| DELETE | `/api/attach/:id` | 登录（本人或超管，且读写） | — | `{removed:true\|false}` |

### 6.1 本地用户 / 远程用户（2026-10-27 新增）

`users.source` 决定口令在哪校验：

- `local`：本站 `salt + 400 轮 SHA-256`；`POST /api/users` 必须带 `password`。
- `radius` / `tacacs` / `ldap`：口令转发给 `auth_servers` 表里 `server_id` 指向的服务器，本站**不保存密码**（`salt`/`hash` 为空串），也不允许在本地重置密码（接口直接 400）。
  `source` 由所选服务器的 `type` 决定，前端传的 `source` 不被信任。

`users.perm` 决定数据权限：`rw` 读写 / `ro` 只读。只读账号可以登录、查看、导出，
但 `PUT /api/ledger`、`POST /api/attach`、`DELETE /api/attach` 一律 403；超管恒为 `rw`。

认证服务器配置（`auth_servers.cfg`，JSON）：

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `secret` | RADIUS / TACACS+ | 共享密钥，只写不回显 |
| `timeout` | 全部 | 秒，1–30，默认 5 |
| `nasId` | RADIUS | 可选，写进 NAS-Identifier 属性 |
| `plain` | TACACS+ | 1 = 发送未加密报文（少数老设备不收加密包） |
| `bindPattern` | LDAP | 绑定 DN 模板，`{user}` 替换为登录名；留空则登录名直接当 DN |
| `baseDn` / `userAttr` | LDAP | 没有模板时拼 `userAttr=用户,baseDn` |
| `tls` / `verifyTls` | LDAP | LDAPS（默认端口 636）；`verifyTls=1` 才校验证书 |

协议实现集中在 **`worker/auth-protocols.mjs`**（纯编解码，传输层由宿主注入）：
RADIUS = UDP Access-Request/PAP（RFC 2865），TACACS+ = TCP AUTHEN/PAP + MD5 混淆（RFC 8907），
LDAP = TCP simple bind（BER，RFC 4511）。**Cloudflare Workers 没有 UDP 出网能力，
公网站点的 RADIUS 会返回 `unsupported`**；TACACS+ / LDAP 走 `cloudflare:sockets`，两端都可用。
内部部署版把该文件放在 `server.js` 同级（`deploy.sh` 自动上传），仓库内则从 `worker/` 动态加载。

### 6.2 CRM（询盘云 / 销售易）台账关联（2026-11-05 新增）

把台账里的客户名称拿到询盘云匹配商机，取回「客户现网信息 / 产品与技术信息 / 维保明细」。
协议实现集中在 **`worker/crm-client.mjs`**（与 `auth-protocols.mjs` 同一种模式：纯 HTTP，宿主注入 `fetchImpl`），
内网版由 `deploy.sh` 与 `server.js` 一起上传，公网 Worker 直接 `import`。**两站代码完全一致**。

登录链路（纯 HTTP，无需浏览器；五个坑都在 `xsyLogin` 里踩过）：

1. **先建租户上下文**：`GET {crm}/global/login.action` 跟 3 跳（→ `/neologin/skip/v2/global/login/info` → `/auc/oauth2/auth`），
   拿到 `SESSION` / `AUC_SESSION` / `auc-sso-oauth-context` / `x-ienterprise-*`。**跳过这一步密码对了也会回 `2030072 长时间未操作`**
2. `GET {auc}/auc/passport/password-key` → `{scode:'200', result:{key:'MIGf...'}}`，**公钥在 `result.key`**，
   把整个 `result` 当字符串会报「不是有效的 ASN.1 结构」
3. 公钥按 **DER 逐层解析**（X.509 SubjectPublicKeyInfo → BIT STRING → SEQ{INT n,INT e}，兼容裸 PKCS#1 / hex 模数），
   再走 **RSA PKCS#1 v1.5** 加密口令（纯 BigInt，Node / Workers 通用）
4. `POST {auc}/auc/login`，**必须 `application/x-www-form-urlencoded`**（发 JSON 会被 301 打回登录页），
   字段 `login_name / password(密文) / login_type=web / device_type=web / mobileParams[login_type]=web`，补 `Origin` / `Referer`
5. **按 `scode` 判成败（只有 200 / 302 算成功）**：失败时 HTTP 仍是 200，只看状态码会把「密码错误」当成登录成功
6. 返回 `tenant_list` 时（本账号就是）先 `POST /auc/oauth2/authorize-code` 选租户换一次性 `code`，
   再跟随跳转落到业务域；多租户且没指定就明确报错列出租户
7. **cookie 必须按域隔离存**：`SESSION` 在 `.xiaoshouyi.com` 与 `crm-tencent.xiaoshouyi.com` 上同名不同值，
   压成扁平 map 会互相覆盖，症状是「登录成功但业务接口 400 / 1020008 未登录」

数据接口：

| 用途 | 请求 |
| --- | --- |
| 商机全量 | `POST /rest/bff/v3.0/neoui/table/search?entityApiKey=opportunity&skipTotalSize=true`，`dataView: opportunity_view_225`，**服务端忽略 `conditions`**，只能全量分页后本地筛 |
| 字段中文标签 | `GET /rest/bff/v3.0/neoui/table/initData1?...&objectApiKey=opportunity` → `data.items[].{apiKey,label}` |
| 维保明细 | `POST /rest/neobi/v2.0/query/query?avatarViewId=3439246815003399`，`application/x-www-form-urlencoded`，`filter` 里 `account.customItem287__c = recordId` |

维保请求体是**整份照抄网页抓包**（`WB_FILTER_TEMPLATE` + `WB_FORM_EXTRA`：`config/dataShareOwner/reportType/layoutId/widgetId`），
只有 `board.filter[0].value[0].val` 换成商机 recordId。响应在 `data.commons`（`{type,row,col,value}` 单元格，`type=1` 是表头），
不是 `data.grid`；`产品名称` 以「配件」开头的行在解析阶段就丢弃 —— 配件不进设备清单、不计台数、也不参与维保三态
（否则「全部到期」会被配件算成「部分到期」）。

「我负责的项目」靠 `users.name_cn`（中文姓名）与商机**维护人A** 精确比对：登录名是拼音，CRM 返中文，
系统不做拼音转换，所以**每个账号必须填中文名**，为空时该账号筛出来永远是空列表（前端会明确提示，不是静默无结果）。
用户表单会从 CRM 快照里汇总出「维护人A/B 出现过的姓名」贴在输入框下方供抄写。

返回体是 NeoBI 的稀疏单元格数组（`{type,row,col,value}`，`type=1` 为表头）。列序：
`销售|合同日期|合同名称|序列号|产品名称|产品型号|维保开始|维保结束|到期天数|操作系统|软件版本`，
解析时按表头文字定位列（不写死下标），并丢弃「台/套数」合计行。**序列号是设备行判据，空则跳过**。

**匹配口径**：第一级 `客户名称` 精确等于台账客户名；不中再走第二级 `项目名称` 双向包含
（先去掉 `技术专用-` 前缀）。多条命中取 `updatedAt` 最新一条并标 `multi`。`updatedAt` 兼容
毫秒时间戳与 ISO 字符串（`Date.parse` 兜底），否则「取最新」会退化成不稳定排序。

**维保三态**（`warrantyStatus`）：按 `end` 与今天比较 —— 全部过期 `expired` / 部分过期 `partial` /
全部未到期 `ok` / 无服务时间 `unknown`。到期当天算未过期（字符串日期 `YYYYMMDD` 比较）。
前端列表徽标（`维保全部到期` / `维保部分到期` / `维保未到期`）与客户详情徽标同源。

**「我负责的项目」**：`users.name_cn`（超管在用户表单里填）与商机的 **`维护人A`** 全等才命中。
**只认维护人A**，维护人B 相同不算（潘超 在「承德银行」是维护人B，不该出现在他的项目里）。

**按用户可见性**：`users.crm_visible` 默认 `0`，但**只管「别人负责的项目」**。
非超管且未开启时，`GET /api/crm/data` 仍会下发「自己台账客户中 `维护人A = name_cn`」的快照（`mineOnly:true`），
保证「我负责的项目」对全员可用；其余客户不下发。超管恒可见，且只下发自己台账里的客户名，不越权看别家。

**区域统计（F8）**：范围是 CRM **全域**商机（与台账客户无关），按 `战区` 精确相等过滤。
口径与多项目聚合一致：设备按序列号去重（去空格、忽略大小写），同序列号保留维保结束最新那条；
台数按去重后计。实测「金融行业部」= 560 个项目 / 156 个有维保 / 1285 台 / 16 个型号，**约 6 分钟**（每项目 1 次 NeoBI 请求 + 250ms 间隔）。
内网后台任务 + 独立进度条；公网 Worker 受单次 50 子请求限制，按 **16 个项目一批**执行、前端轮询到 `needNext` 自动续跑下一批，
明细按 60 万字符分片存 `crm_stat_chunk`（大战区设备上万台，D1 单行 1MB 放不下）。

**「产品型号」为空（2026-11-06）**：CRM 维保表用 `--` 表示未填（型号 / 操作系统 / 软件版本都会出现）。
解析时统一由 `crmBlank()` 归一为空串；型号为空再调 `modelFromProduct()` 从**产品名称**里识别
（`ZDNS T5100` → `T5100`、`核心网络服务设备 T5100S` → `T5100S`），识别不到（软件类，如「红枫下一代互联网域名服务软件V3.0」
「标准DNS-8万QPS」）留空。前端明细显示灰字「未填」，汇总归入「（未填型号）」一行，可下钻，CSV 同样写「（未填型号）」。
实测泰康 49 台里 12 台型号为 `--`，金融行业部全区 1286 台里 85 台（6.6%），集中在软件类产品。

**定时任务**：内网 `server.js` 用 `setInterval(60s)` 判断「上次运行 + 间隔小时」是否到期；
公网 Worker 用 Cron Trigger（`wrangler.jsonc` 的 `crons: ["0 * * * *"]`）在 `scheduled()` 里做同样判断。
默认 12 小时，可在管理页改成 1–168。**登录态由服务端自己拿**（存 `crm_config.session`，失效自动重登一次），
不依赖任何人的浏览器会话——这是本功能最关键的约束。

新表：

| 表 | 字段 | 说明 |
| --- | --- | --- |
| `crm_config` | k(PK, 固定 `main`), v(JSON) | `{loginName, password, intervalHours, lastSyncAt, lastResult, session}`；密码只写不回显；另有 `progress`（公网检索进度）、`stat_regions`（战区分布缓存）、`stat_progress`（区域统计进度） |
| `crm_matches` | customer_name(PK), status(`ok`/`miss`), record_id, level(1/2/3), multi, data(JSON), updated_at | 每个台账客户一行快照；`data` 存 `{opp, projects, maintenance, warranty, error}` |
| `crm_stat` | region(PK), updated_at, data(JSON) | 区域统计缓存：`{stats, rows, summary, projects, truncated}`（公网为瘦身版，明细在 `crm_stat_chunk`） |
| `crm_stat_chunk` | region+idx(PK), data(JSON) | **仅公网**：明细分片，每片约 60 万字符 |
| `crm_stat_state` | region(PK), updated_at, data(JSON) | **仅公网**：分批续跑的中间态（项目列表 / 已拉设备 / 进度） |

接口：`GET/PUT /api/crm/config`、`POST /api/crm/test`、`POST /api/crm/sync`、`GET /api/crm/status`
（均超管）、`GET /api/crm/stat/meta`、`GET /api/crm/stat/data?region=`、`GET /api/crm/stat/status`
（超管 + `stat_visible` 账号）、`POST /api/crm/stat/run`（**仅超管**，全量拉取耗时长，避免多人重复跑）、
`GET /api/crm/data`（登录用户，`crm_visible` 关闭时只回「我负责的项目」）。



照片三接口两套实现都有：首页无账号体系，故不要求登录，但校验同源 `Origin` 与文件头（jpg/png/webp）。
存储介质不同——内部版落 `DATA_DIR/photo/hero.<ext>`（挂载卷，重建镜像不丢，上限 8MB）；
Cloudflare 版以 base64 存 D1 的 `home_photo` 单行（受 D1 单行 2MB 限制，上限 1.4MB）。
前端探测顺序为 `/api/photo/current` → `assets/hero-photo.jpg`（仅在接口不可用时回落）。

规则要点：
- `username` 3–32 位 `[A-Za-z0-9_.-]`，入库前转小写；口令 ≥ 6 位。
- 普通用户 PUT 只能写 `scope === 自己`；超管可指定任意已存在账号。
- 新建/重置口令的账号 `must_change = 1`（前端强制改密）。
- 至少保留一个启用的超管，否则拒绝删除/停用/降级。

---

## 7. 接手必读：十一个坑（都踩过，别再踩）

1. **不要新增 `_headers`。** Workers 静态资源永不更新「已存在的」`_headers`，改了线上仍旧策略，曾导致地图样式域名被拦、底图全灰。CSP 走页面 `meta`，其余安全头由 Worker 注入。
2. **`assets.run_worker_first` 必须是 `true`。** 写成路径数组时只有匹配路径进 Worker，页面类响应拿不到安全头。
3. **ETag / 304 在 Workers 静态资源上走不通。** 边缘会剥离 Worker 设的 `ETag`，只能靠 `max-age + stale-while-revalidate`。
4. **层叠刻度不要乱设。** 主内容 100 → 内容页 `.page` 150 → 浮层 `.high` 320 → toast 400。凡可能从「客户管理 / 用户管理」内部打开的弹窗，容器必须带 `high`，否则被整屏页面盖住（表象是「点了没反应，返回后才出现」）。
5. **口令算法有三处实现，改一处必须同步三处**：前端 `hashPwd()`、`worker/index.js` 的 `hashPwd()`、`tests/test-helpers.js`。算法为 `salt|pwd` 起手、400 轮 `SHA-256`。
6. **省界数据是异步加载的。** `migrate()` 里用 `PROV_MAP` 过滤 `region.provinces` 前必须判 `PROVINCES.length`，否则数据未到时会清空省份归属并写回服务端。改 `assets/provinces.js` 内容必须同步提升 `PROV_SRC` 与 `<link rel=preload>` 两处 `?v=`。
7. **地图 SDK 必须异步、带超时。** 同步加载时地图域名一慢就阻塞整页解析，登录框永不出现；现为 15 秒超时 + 失败提示。
8. **腾讯地图 Key 依赖域名白名单。** 换域名要到腾讯位置服务控制台加白，否则底图空白；WebGL 被关闭也会空白，页面内有「检测显卡支持」自查按钮。
9. **部署后不要立刻断言失败。** 边缘缓存 1–2 分钟，刚发布可能仍命中旧副本；无头浏览器验证大页面要轮询 `document.readyState === 'complete'`，固定 sleep 会误判。
10. **弹窗防误关是全局约定，新增弹窗要登记。** 只读弹窗（预览 / 提醒 / 导出 / 确认）点遮罩直接关；表单弹窗一律加进 `FORM_MASKS`，一旦被改动过（`input`/`change` 或 `markDirty()` 手动标记），点遮罩或按 Esc 先弹「放弃填写的内容？」。遮罩点击要求「按下与抬起都在遮罩上」（`maskDown`），避免拖选文字误判。Esc 只关最上层（`topMask()` 按 z-index 取峰值）。`maskConfirm` 固定 `z-index:350`，否则会压在 `.high` 弹窗下面看不见。**用 JS 赋值改表单（坐标回填、按钮组、动态增删行）不会触发事件，必须手动 `markDirty(id)`**，否则拦截失效。
11. **`me` 已经是驼峰对象，别再读下划线列名。** 两版服务端的 `currentUser()` 都过 `mapUser()`，返回的是 `crmVisible` / `nameCn` / `hideSensitive` 这类驼峰字段。曾用 `me.crm_visible` 判可见性 → 永远 `undefined` → 非超管始终看不到 CRM 数据，而登录 bundle 又是对的，极难发现。**新加的 users 列一定要同时改三处**：`USER_COLS`、`currentUser()` 的 `SELECT`（漏了 `u.name_cn/u.crm_visible` 会得到 `undefined`）、`mapUser()` 映射。

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
| `test-board.js` | 79 | 季度切换、达标判定、客户/巡检增删改、导出、城市候选、**总览页（KPI/区域覆盖/待办下钻/季度联动）与详情分段导航** |
| `test-board-edge.js` | 9 | 空数据、极端频率、无坐标客户 |
| `test-monthly.js` | 44 | 逐月覆盖、当月未到、同月多次只算一次 |
| `test-auth.js` | 185 | 登录门禁、停用账号、角色边界、汇总只读、数据隔离、远程登录不弹改密、账号区显示登录名、批量编辑（含区域统计可见性） |
| `test-map.js` | 44 | 带洞结构、标记数量、切换与登出时图层重建、AMap 门面增量同步 |
| `test-custs.js` | 125 | 客户管理页字段、搜索、CRUD、层叠守卫、敏感字段逐条展开 |
| `test-units.js` | 39 | 巡检分组：三态判定、整体巡检、y12×分组、表单编辑、详情勾选 |
| `test-half.js` | 26 | 一年2次：半年窗口、跨季度一致、other 不计、半年×分组、KPI/CSV 口径 |
| `test-modal-guard.js` | 31 | 弹窗防误关：只读直接关、改动拦一句、Esc 只关最上层、拖选不误判 |
| `test-crm.js` | 113 | CRM 展示层：维保三态徽标与顺序、详情两块、配件不展示、项目技术负责人、我负责的项目筛选、可见性关闭只影响别人负责的项目、管理页 PUT/POST、**区域统计独立页（战区下拉/明细 11 列/四项筛选/型号汇总/下钻/CSV/进度条/空型号显示未填/按账号授权只读/停止检索与部分结果）** |
| `test-crm-client.mjs` | 127 | 询盘云协议：RSA 登录、选租户换 code、域隔离 cookie、商机分页、字段标签化、NeoBI 维保解析（剔除配件/销售/合同列）、三态、三级匹配、端到端同步、**区域统计去重与型号汇总、CRM 空值（--）归一与型号回退、shouldStop 中断（部分结果/零结果）** |
| `test-home.js` | 98 | 首页结构/动效/降级、部署产物、省界拆分与版本号一致性 |
| `test-photo-api.js` | 13 | 照片接口（两版等价） |
| `test-visits.js` | 62 | 巡检方式/结果/附件/巡检人必填 |
| `test-attach.js` | 30 | 附件上传下载、扩展名持久化 |
| `test-remote-auth.js` | 53 | 本地/远程用户界面、只读拦截、认证服务器增删改测 |
| `test-protocols.mjs` | 27 | RADIUS/TACACS+/LDAP 真实报文（本地起假服务器，Node 直跑） |
| `test-worker-api.mjs` | 90 | Worker 接口跑在 node:sqlite 的 D1 兼容层上，验证 SQL 与权限分支（含 CRM 配置/可见性/区域统计授权/越权） |
| `test-session.mjs` | 20 | 会话滑动过期 |
| **合计** | **1215** | 19 套，约 90 秒跑完 |

> `test-protocols.mjs` / `test-worker-api.mjs` 是 `.mjs`（ESM），因为它们直接 import
> `worker/auth-protocols.mjs` 与 `worker/index.js`。`test-worker-api.mjs` 用 Node 内置
> `node:sqlite` 模拟 D1，能抓到「Worker 版 SQL 写错、上线才炸」这类问题。

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

### 11.1 交付约定（2026-11-06 用户明确）

1. **内网为准，公网不做设计约束**：不再为 Cloudflare 的 50 子请求上限、D1 单行 1MB、免费版时长等做妥协；
   功能按内网（Docker + node:sqlite）的真实能力实现。公网 Worker 仍随仓库推送，但**能否跑通不作为验收条件**。
2. **验收 = 本机验证 + 内网实例验证通过**，然后正常 `commit` + `push`。
3. **唯一硬性要求**：git 仓库里的代码必须与内网 `/opt/inspection` 运行的代码**完全一致**。
   为此 `deploy.sh` 部署末尾自动比对 `git HEAD` 与服务器文件（5 个源文件 + `assets/` 全量 md5）：
   - 退出码 `0` = 一致；`3` = 本地有改动未提交（正常中间态，提示提交后复验）；`2` = 已提交却与内网不符（提交遗漏或服务器被手改）。
   - `SSH_PASS='口令' bash deploy/internal/deploy.sh --verify` 只校验、不部署，提交推送后用它复验。
   - `assets/` 比对会忽略 macOS 的 `._*` / `.DS_Store`（tar 打包也会排除），其余任何差异都算不一致。
   - 服务器上手工改文件属于禁止操作；紧急改也必须回写仓库并提交。

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
7. **账号体系与协同**（2026-10-27 ~ 10-29）：本地/远程账号（RADIUS/TACACS+/LDAP）、只读权限、
   全员数据日志、用户列排序与「复制配置」、客户管理列排序 / 批量删除 / 导入数据移植、
   AMap 门面增量更新修复（标签时有时无）。
8. **会话超时与附件体验**（2026-10-30）：
   - 登录超时按用户配置（users.session_mins，默认 30 分钟，范围 5–43200，滑动过期：
     每次通过鉴权的请求顺延半个周期阈值后才续期；前端另有同口径的空闲自动登出）。
   - 巡检登记：备注框可直接粘贴图片（进附件队列）；整个客户详情弹窗支持拖拽投放；
     附件在线预览扩展到 Excel（.xls/.xlsx，SheetJS 渲染为带工作表切换的表格）与
     Word（.docx，mammoth 转 HTML）。预览组件按需加载，位于 `assets/vendor/`
     （xlsx.full.min.js / mammoth.browser.min.js，`?v=` 破缓存），旧 .doc / .ppt 仍只提供下载。
9. **巡检分组 / 频率档位 / 附件上限**（2026-11-03 ~ 11-04）：客户内部分组与三态完成度、
   一年 2 次（半年口径）、附件上限提到 100MB。
10. **CRM 台账关联**（2026-11-05）：逆向询盘云账密登录（纯 HTTP + RSA），
    服务端 12 小时自动同步商机与 NeoBI 维保明细；客户详情两块现网/技术信息、
    列表维保三态徽标、「我负责的项目」筛选、按账号 CRM 可见性开关。

更细的「每轮需求原话 → 根因 → 交付结果」记录在项目内部档案里（含个人信息，未随仓库公开），
需要时向原负责人索取。
