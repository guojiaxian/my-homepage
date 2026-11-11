# AGENTS.md · my-homepage 项目交接记忆

> 面向接手本项目的 AI Agent / 开发者：读完这一份即可上手，无需再翻聊天记录。
> 最后更新：2026-11-11 · 文档随代码演进，改功能时请同步更新本文；应用中心 ⇄ 监控中心双向同步见 §17，2026-11-10 的 UI/图表/目录设置记忆见 §16。

---

## 1. 这是什么

个人应用展示主页（Vue 3 单页应用），列出**本机 `/root/applications` 下的自研应用**、**局域网其他主机上的外机应用**以及**云服务器上的公网应用**，展示：名称、简介、实际访问端口、部署位置/目录、GitHub 地址、运行状态、git 源码同步状态。

核心设计目标：**应用信息与状态全自动维护**——端口、上下线、源码同步情况由服务端定时探测，增删应用/改信息通过首页设置面板完成，日常无需登录服务器改文件。

2026-11-10 起新增两大能力（详见 §8.7）：**服务器监控看板 `/monitor/`**（多机指标采集 + 目录级资源归属 + 告警 + 历史）与 **Web SSH 终端**（看板点击主机直接进目标机终端）。

- 线上地址：`http://<本机IP>/`（本机 `10.8.11.4`，nginx 80 端口，`default_server`）；监控看板 `http://<本机IP>/monitor/`
- 项目根目录：`/root/applications/my-homepage`（已纳入 git，origin `github.com:guojiaxian/my-homepage`；改动请及时 commit/push）
- 部署产物目录：`/root/applications/my-homepage/www`（项目内）
- 旧路径 `/root/gjx-homepage`：为兼容保留的**软链接**，指向新目录；确认无人依赖后可 `rm /root/gjx-homepage`（若 shell 正停在该路径，先 `cd` 到别处）

> ⚠️ 部署目录位于 `/root` 之下仍能正常访问，是因为本机 nginx 配置为 `user root;`（worker 也以 root 运行）。**若日后把 nginx 降权为 `nginx` 用户，站点会立刻 403**——届时需把 webroot 移出 `/root`（可用 `move-project.sh --webroot`）或放开目录遍历权限。

> ℹ️ **本项目自身也作为普通应用登记在 `apps[]` 里**（id `my-homepage`，`expectedPort: 80`）。它由 nginx 托管，进程 cwd 不在项目目录，因此走「`expectedPort` TCP 兜底」探测；「是否对外监听」从 `ss` 端口表判定，不会误标「仅本机」。⚠️ 项目根目录下常驻的监控网关 8301 会被 cwd 匹配命中，**2026-11-10 已修正**：`expectedPort` 正在监听且不归属其他应用时优先作为主端口，8301 只进 `extraPorts`。若此时跑 `npm run dev`，5173 开发实例同样只作为附加端口。

---

## 2. 关键事实速查

| 项 | 值 |
|---|---|
| 服务器 | Kylin Linux Advanced Server V10 (Halberd)，内网 IP `10.8.11.4` |
| 运行时 | Node `v22.19.0`（`/usr/local/bin/node`）、npm `10.9.3` |
| Web 服务器 | nginx `1.20.1`，80 端口 `default_server` |
| 前端栈 | Vue 3 + Vite 5，**无路由 / 无状态库 / 无 UI 组件库 / 零第三方运行时依赖** |
| 构建产物体积 | gzip 后约 34KB（css ~2.5KB + js ~31KB） |
| 设置 API | `127.0.0.1:8300`（仅回环监听，nginx 反代 `/api/`） |
| 监控网关 | `127.0.0.1:8301`（仅回环，nginx 反代 `/api/monitor/` 与 `/api/terminal` WS）；看板在**主页内**（顶栏「应用中心 / 监控中心」标题切换，`#monitor` hash 可直达），`/monitor/` 仅剩重定向 stub + 终端弹窗页 |
| 监控登录密码 | 首启随机生成于 `data/monitor/INITIAL_PASSWORD.txt`（0600），登录后请在设置中修改 |
| 监控采集模式 | `hosts[].mode`：`ssh`（中心拉取，默认/公网机）或 `agent`（目标机推送，内网机）；netwatch=agent 实测中 |
| 被监控主机 | 4 台：本机（local）+ netwatch(10.8.14.200, agent) + aliyun(47.95.140.199, ssh) + lan-1103(10.8.11.3, ssh)；均 ONLINE（2026-11-10） |
| 探测定时器 | `my-homepage-probe-quick.timer` 每 3 分钟（`--no-fetch`）；`my-homepage-probe.timer` 每 5 分钟（完整，含 fetch） |
| 前端轮询 | 主页每 60 秒拉一次 `apps.json`；监控看板每 5 秒拉 summary |
| 已登记应用 | 12 个（9 个本机 + 2 个外机 + 1 个公网；含 2 个离线应用） |
| 后端依赖 | 主站仍零依赖；监控网关新增 `ssh2`/`ws`（终端与远程采集），前端 vendor 库 echarts/xterm 随仓库提交 |

**运行中的 systemd 单元（均已 enable）**

```bash
systemctl status my-homepage-settings.service   # 设置 API，常驻
systemctl status my-homepage-probe.timer        # 每 5 分钟完整探测（含 fetch）
systemctl status my-homepage-probe-quick.timer  # 每 3 分钟快速探测（--no-fetch）
systemctl status my-homepage-monitor.service    # 监控网关（指标采集 + Web 终端），常驻
```

> 目标服务器上另有 **`my-homepage-agent.service`**（agent 推送模式的常驻单元，运行在 netwatch/113 等**目标机**上，不在本机）——由一键安装脚本部署，见 §8.7。

---

## 3. 60 秒上手

```bash
cd /root/applications/my-homepage

npm install            # 仅构建需要（node_modules 已存在）
npm run probe          # 手动跑一次探测（--no-fetch 跳过 GitHub fetch）
npm run dev            # 本地开发，0.0.0.0:5173（apps.json 走 public/ 静态副本）
npm run build          # 构建到 dist/
./deploy.sh            # 一键发布：探测 → 构建 → rsync 到 webroot → nginx -t && reload

curl -s http://127.0.0.1/apps.json | head -40     # 看探测结果
curl -s http://127.0.0.1/api/config | head -40    # 看当前配置
curl -s http://127.0.0.1/api/monitor/healthz      # 监控网关存活
systemctl restart my-homepage-settings           # 改了 settings-server.mjs 后必须重启
systemctl restart my-homepage-monitor            # 改了 monitor-server.mjs 后必须重启（改配置文件不用，≤2s 热加载）

./scripts/start.sh      # 启用开机自启并启动（+ 立即探测一次）
./scripts/restart.sh    # 重启各服务（不改变自启状态）
./scripts/stop.sh       # 停止 + 取消开机自启 = 永久关闭
```

> `deploy.sh` 的顺序**不可调换**（探测必须在构建之前），原因见 §11 踩坑 #3。

---

## 4. 架构与数据流

```
                        ┌──────────────────────────────┐
                        │ scripts/apps.config.json     │  ← 唯一数据源（手工 / 设置面板维护）
                        │  apps[] remoteApps[] page{}  │
                        └──────────────┬───────────────┘
                                       │ 读取
             ┌─────────────────────────┴──────────────────────────┐
             │                                                    │
   ┌─────────▼──────────┐                              ┌──────────▼───────────┐
   │ probe-apps.mjs     │  timer：完整5min/快速3min     │ settings-server.mjs  │
   │  · 端口探测(ss+proc)│                              │  GET  /api/config    │
   │  · git 同步检测     │                              │  POST /api/config    │
   │  · 远程健康探查     │                              │   → 写配置 + 后台探测 │
   └─────────┬──────────┘                              └──────────┬───────────┘
             │ 写出 apps.json（两处，内容相同）                      │ 保存后触发
             ├──► /root/applications/my-homepage/public/apps.json  ──┐        │ probe --no-fetch
             └──► /root/applications/my-homepage/www/apps.json  ◄─────┘        │
                                       │                         │
                                       │ nginx 静态托管           │
   ┌───────────────────────────────────▼─────────────────────────▼──────────┐
   │ 浏览器: Vue SPA（src/）                                                  │
   │  · 启动 fetch apps.json，之后每 60s 轮询                                  │
   │  · 设置面板 fetch /api/config → 保存 → 轮询 probedAt 变化后自动刷新        │
   └────────────────────────────────────────────────────────────────────────┘
```

**为什么 apps.json 写两份**：`public/apps.json` 供本地 dev 与下次构建打包用；`/root/applications/my-homepage/www/apps.json` 是线上生效文件。探测器直接写 webroot，所以**纯数据改动无需重新构建前端**。

---

## 5. 文件地图

```
/root/applications/my-homepage/
├── index.html                 # Vite 入口，<title> 会被前端按 page.siteName 覆盖
├── package.json               # scripts: dev/build/preview/probe/deploy
├── vite.config.js             # base: './'，dev server 0.0.0.0:5173
├── deploy.sh                  # ★ 一键发布（顺序：探测→构建→rsync→reload）
├── README.md                  # 面向人的使用说明（功能、配置、nginx、排序等）
├── AGENTS.md                  # ← 本文件，面向 Agent 的交接记忆
├── scripts/
│   ├── apps.config.json       # ★★ 唯一数据源：apps / remoteApps / page / order / $comment
│   ├── apps.config.json.bak   # 设置面板每次保存前自动生成的备份
│   ├── probe-apps.mjs         # ★★ 探测器（端口 + git 同步 + 远程健康），零依赖
│   ├── settings-server.mjs    # ★★ 设置 API，零依赖，仅监听 127.0.0.1:8300
│   ├── monitor-server.mjs     # ★★ 监控网关（采集/目录归属/告警/终端/审计），依赖 ssh2+ws，仅监听 127.0.0.1:8301
│   ├── monitor.config.json    # ★ 监控配置（主机/跟踪目录/阈值/终端限制；≤2s 热加载；.bak 自动备份）
│   ├── start.sh               # 手动启动：enable --now 四个单元 + 立即探测一次
│   ├── restart.sh             # 手动重启（不改变自启状态）
│   ├── stop.sh                # 手动停止：disable --now = 永久关闭（重启不自启）
│   └── move-project.sh        # 项目目录迁移（自动修正 systemd/文档/可选 webroot 路径）
├── systemd/
│   ├── my-homepage-probe.service / .timer     # 每 5 分钟完整探测（含 git fetch）
│   ├── my-homepage-probe-quick.service / .timer  # 每 3 分钟快速探测（--no-fetch）
│   ├── my-homepage-settings.service           # 设置 API 常驻
│   └── my-homepage-monitor.service            # 监控网关常驻
├── public/
│   ├── favicon.svg            # 四宫格蓝色图标（与顶栏 brand-mark 同源设计）
│   └── apps.json              # 探测产物（构建时随 dist 拷贝）
├── src/
│   ├── main.js                # createApp(App).mount('#app')
│   ├── style.css              # ★ 设计变量（浅色/GitHub Dark）+ 全局组件样式
│   ├── App.vue                # ★ 布局、数据轮询、主题、视图切换、排序状态、设置入口
│   ├── lib/app-utils.js       # 纯函数：URL 拼接、端口文案、git 状态映射、环境标签、uptime 格式化
│   └── components/
│       ├── AppTable.vue       # 表格视图（可排序表头 + 拖拽手柄列）
│       ├── AppCard.vue        # 卡片视图（上移/下移按钮 + 拖拽手柄）
│       ├── SettingsPanel.vue  # ★ 设置面板（页面信息 + 应用列表 + 点击弹窗编辑）
│       ├── MonitorView.vue    # ★ 监控中心视图（顶栏「监控中心」标题切换进入；hero/主机卡/告警横幅/登录）
│       ├── MonitorDetail.vue  # ★ 监控内联详情（4 趋势图 + 分区/目录占比 + 目录对比 + 进程明细）
│       ├── MonitorSettings.vue# ★ 监控设置弹窗（主机紧凑列表/目录/阈值/终端/改密/审计）
│       ├── MonitorHostEdit.vue# ★ 单主机编辑弹窗（草稿/直连双模式，被设置面板与详情页 ⚙ 复用）
│       ├── MonitorTerm.vue    # ★ Web 终端抽屉（xterm 动态分包；弹窗放大走 monitor/terminal.html）
│       └── PageHero.vue       # 应用中心 / 监控中心共用页头（标题 + 副标题 + 统计 chip 插槽）
├── src/lib/
│   ├── app-utils.js           # 纯函数（主页共用）
│   ├── monitor-api.js         # 监控 API 封装 + 格式化
│   └── monitor-charts.js      # ECharts 按需引入（echarts/core，动态 import 独立分包）
├── glass/                     # ★ 独立毛玻璃页面（纯 HTML/CSS/JS，不参与 Vite 构建）
│   ├── index.html
│   └── assets/glass.css, glass.js
├── unslop/                    # ★ 独立设计对比端点 /unslop/（主站重设计版，纯 HTML/CSS/JS，见 §8.6）
│   ├── index.html
│   └── assets/app.css, app.js
├── monitor/                   # ★ 监控中心残留端点（看板本体已并入主站 SPA，见 §8.7）
│   ├── index.html             # 仅重定向 stub → /#monitor（为旧链接/书签保留）
│   ├── terminal.html          # 独立终端页（弹窗放大用，?host=<id>，自带 vendor xterm）
│   └── assets/terminal.js, vendor/(xterm+xterm-addon-fit+xterm.css)
├── data/                      # 运行数据（已 gitignore，勿入库）
│   └── monitor/               # history/*.jsonl 分钟历史 · audit.jsonl 审计 · alerts.jsonl 告警
│                              # credentials.json(AES-GCM 凭据+主机指纹+agent token) · .secret(密钥) · .password-hash(登录哈希)
│                              # sessions.json(持久会话) · keys/ 监控专用 SSH 密钥
│                              # INITIAL_PASSWORD.txt(首启密码，改密后可删)
├── docs/
│   ├── monitor-terminal-blueprint.md  # ★ 监控+终端 落地方案（选型对比/架构/安全/视觉）
│   └── monitor-ops.md                 # ★ 监控运维手册（部署/配置/扩缩容/排障）
├── dist/                      # 构建输出（不手工编辑）
├── .verify/                   # 开发期截图与 Playwright 脚本（可删，不影响运行）
└── node_modules/
```

**修改后的生效路径**

| 改了什么 | 如何生效 |
|---|---|
| `apps.config.json`（数据） | 设置面板保存，或 `npm run probe` |
| `probe-apps.mjs` | 自动生效（下次定时探测）；也可 `npm run probe` |
| `settings-server.mjs` | `systemctl restart my-homepage-settings` |
| `monitor-server.mjs` | `systemctl restart my-homepage-monitor`（`monitor.config.json` 与看板设置界面改动 ≤2s 热加载，无需重启） |
| `src/**`（前端） | `./deploy.sh`（须重新构建） |
| `glass/**` / `unslop/**` / `monitor/**`（独立静态页） | 刷新即生效（nginx 直发，无需构建） |
| `deploy.sh` / nginx | 直接执行 / `nginx -s reload` |

---

## 6. `scripts/apps.config.json` 规格

四个顶层键：`apps`（本机应用）、`remoteApps`（远程应用）、`page`（页面文案）、`order`（可选全局顺序），外加 `$comment`（说明文字，保存时原样保留）。

### 6.1 `apps[]` — 本机应用条目

```json
{
  "id": "study-log",                              // 必填。必须等于 /root/applications 下的目录名（归属匹配靠它）
  "name": "StudyLog 成绩记录",
  "description": "一句话简介（主页表格显示 3 行内）",
  "directory": "/root/applications/study-log",    // 缺省时自动补 /root/applications/<id>
  "expectedPort": 3000,                           // ★ 主端口锚点：目录下可能有非 Web 附属监听
  "kinds": ["web"],                               // 应用形式：web / app / miniapp / tv / cli，可多选
  "env": "lan",                                   // 部署位置：lan 内网 / public 公网
  "https": false,                                 // 可选：访问链接是否用 https（仅本机应用）
  "languages": ["JavaScript"],                    // 主要语言（数组，留空则自动识别）
  "frontend": ["Vue 3", "Vite"],                  // 前端框架（数组）
  "backend": ["Fastify"],                         // 后端框架（数组）
  "github": "https://github.com/guojiaxian/Study-log",
  "tags": ["AI"],
  "icon": "📚",                                   // emoji
  "exclude": true                                 // 可选：完全不在主页显示（连条目都不出现）
}
```

- `expectedPort` 的作用见 §7.1「主端口选择」——**遇到目录下有多个监听时务必填写**。
- `kinds` 是**应用形式**（可多选）：`web` / `app` / `miniapp` / `tv` / `cli`，同时决定是否探测：含 `web` 就探测 Web 端口；不含 `web` 则视为**离线应用**（纯 APP / 小程序 / 电视 / CLI），不做端口探测、状态显示灰色「离线应用」。例如 `["web","app"]` 既有网页又有 APK，仍会探测 Web。
- `languages` / `frontend` / `backend` 是**技术栈展示字段**（字符串数组）。本机应用留空时由探测器自动识别（见 §7.2.1）；填写后以手动值为准。远程应用没有本机目录，必须手动填写。
- 远程应用可选 **外机 git 检查字段**（2026-11-11 新增，见 §7.3.1）：`gitDir`（外机上项目目录绝对路径，配置了才做检查）、`gitSsh`（SSH 目标 user@host，缺省 `root@<host>`）、`gitKey`（私钥路径，推荐复用监控密钥 `data/monitor/keys/<hostId>`）。设置面板远程应用弹窗可编辑（白名单已放行）。`env: public` 的公网机按**线上机**口径检查与展示（见 §7.3.1）。
- 旧字段 `type: "app"` 仅作为缺省分类推断的兼容回退（`kinds` 缺省时 → `["app"]`），**不再参与探测判断**；设置面板已移除该勾选，保存配置时会被丢弃。
- `env` 是展示用的部署位置，缺省 `lan`（本机应用）；远程应用缺省 `public`。它不影响端口探测与远程健康探查，只影响首页蓝色/橙色标签与统计。
- `https: true` 让本机应用的访问链接使用 `https://`（缺省 false，即 http）。远程应用直接用 `url`，不受此字段影响。
- `exclude: true` 表示「根本不显示」；离线应用与此无关，仍会显示为灰色「离线应用」。
- 未登记的目录若在监听会被**自动发现**，以 `pending: true` + 「待补充」标签出现在主页末尾。

### 6.2 `remoteApps[]` — 远程应用（公网/云服务器）

```json
{
  "id": "study-log-cloud",
  "name": "StudyLog 公网版",
  "description": "…",
  "healthUrl": "http://47.95.140.199:3000/api/v1/health",   // ★ 必填，http/https
  "url": "http://47.95.140.199:3000",                       // 点击跳转地址，缺省取 healthUrl 同源
  "location": "阿里云",                                      // 表格「服务器/目录」列显示「阿里云 · <host>」
  "host": "47.95.140.199",                                  // 缺省取 healthUrl 的 hostname
  "kinds": ["web"],                                         // 应用形式，可多选；缺省 ["web"]
  "env": "public",                                          // public=公网应用（云服务器）；lan=外机应用（局域网其他主机）；缺省 public
  "languages": ["JavaScript/Node.js"],                      // 主要语言（远程应用手填）
  "frontend": ["Vue 3"],                                    // 前端框架
  "backend": ["Fastify"],                                   // 后端框架
  "monitorSync": true,                                      // 可选：勾选后自动同步到监控中心（§17）
  "github": "…", "tags": ["公网"], "icon": "☁️"
}
```

健康接口期望返回（StudyLog 实际返回示例）：

```json
{"status":"ok","dbReady":true,"rssMb":78,"uptimeSec":1088946,"version":"1.1.0","time":"…"}
```

解析规则：`version`（兼容 `data.version`）→ 应用名旁 `v1.1.0` 标签；`dbReady`/`uptimeSec`/`rssMb` → 状态徽标悬停明细；**在线判定 = HTTP 2xx 且（若有 `status` 字段）值为 `ok`**。外机 git 同步检查见 §7.3.1（可选，配置 `gitDir` 才做）。**同步到监控中心**：条目带 `"monitorSync": true`（设置面板远程应用弹窗勾选）时，monitor-server 自动维护同 id 的被监控主机，机制见 §17。

### 6.3 `page` — 页面文案（设置面板可改）

```json
"page": {
  "siteName": "我的应用导航",       // 顶栏 + document.title + 页脚
  "heroTitle": "应用中心",
  "heroSubtitle": "部署在这台服务器上的个人项目，…"
}
```

### 6.4 `order` — 可选，全局默认顺序

```json
"order": ["study-log", "cloud-monitor", "…"]
```

未列出的应用按原相对顺序排在后面。**优先级**：浏览器手动排序（localStorage）> `order` > 配置文件数组顺序。当前未设置 `order`。

---

## 7. 探测机制详解（`scripts/probe-apps.mjs`）

零依赖 Node 脚本，单次典型耗时：`--no-fetch` 约 **0.3 秒**；完整 fetch 约 **6 秒**（10 个仓库、并发 6，实测 5.7 秒；网络差时更久，单仓 fetch 上限 20 秒）。

### 7.1 端口探测（本机应用）

1. 解析 `ss -tlnp` → 每个 `LISTEN` 的端口、地址族（是否对外）、PID；
2. 读 `/proc/<pid>/cwd` 判断进程是否位于 `/root/applications/<目录>` 下 → 该端口归属此应用；`/proc/<pid>/cmdline` 兜底匹配绝对路径；
3. 进程匹配不到的，退回用 `net.connect` 探 `expectedPort`（1.5s 超时，连上即断，不发 HTTP）；「是否对外监听」取 `ss` 端口表（`listenerExternal`），因此 nginx 托管的本站 :80 不会被误标「仅本机」；
4. **主端口选择**（`pickPrimary` + expectedPort 优先）：配置的 `expectedPort` 正在监听、且不归属其他应用时优先作为主端口（避免项目目录内附属进程如监控网关 8301 被误判）→ `expectedPort` 在已归属端口里则锚定它 → 否则取最小的**对外**监听端口 → 全为仅本机时取最小值。其余端口进 `extraPorts` 显示为 `+2222, 18099`。
   > 这条规则是踩坑换来的：network-monitor 目录下曾有仅本机的 `sshmockd`(:2222) 非 HTTP 进程，原「取最小端口」规则会生成坏链接。
5. 仅本机监听的端口会在前端标注「仅本机」。

### 7.2 git 同步检测

对每个含 `.git` 的目录：

- **fetch 校准**：**并发执行**，默认 6 个同时（`PROBE_FETCH_CONCURRENCY` 可覆盖）。只 fetch 当前分支所属的远端（通常是 `origin`），加 `--no-tags`，不再 `--all` 扫描所有远端；`GIT_TERMINAL_PROMPT=0`、SSH `BatchMode` + `ConnectTimeout=8` + `ControlMaster/ControlPersist=60`（多仓库复用 SSH 连接）、单仓超时 20 秒。`--no-fetch` 参数跳过此步（沿用上次远端快照）。
- **互斥锁**：完整探测与快速探测通过 `/tmp/my-homepage-probe.lock` 互斥。快速探测（`--no-fetch`）遇到锁直接跳过；完整探测最多等 60 秒，避免两个进程同时写 `apps.json`。
- **工作区核对**：`git status --porcelain=v1` → `??` 计未跟踪，其余计未提交。
- **推送核对**：`git rev-list --left-right --count @{upstream}...HEAD`，无分支上游时退回 `origin/HEAD`。
- 全程 `--no-optional-locks`（**不写 `.git/index`**）；除 fetch 写 `FETCH_HEAD`/`refs/remotes/*` 外**不触碰仓库**，更不改工作区代码。

状态优先级：`dirty`（未提交）> `ahead`（未推送）> `behind`（未拉取）> `untracked`（未跟踪）> `no-upstream` > `synced`；另有 `no-repo`（无仓库）、`error`（检查失败）。

### 7.2.1 技术栈自动识别

`detectStack(dir)` 只对本机应用目录运行，读取带深度限制的 `package.json`（含 `server/`、`web/`、`mobile/` 等子项目）、`requirements.txt`、`pyproject.toml`、`go.mod`、`build.gradle(.kts)`、`app.json`/`project.config.json`、README，以及少量 HTML/JS/Py 文件内容，得到：

- `forms`：`app`（Capacitor / Android）、`tv`（Android + TV 关键字）、`miniapp`（微信小程序）、`cli`（pyproject scripts 且无 Web 后端）等，仅把**非 web** 形式并入 `kinds`，避免误改探测行为；
- `languages`：Python / JavaScript / TypeScript / Go / Kotlin / WXML/WXSS；
- `frontend`：Vue 3（含 Vite/ECharts 等）、React、Android 原生 Kotlin、微信小程序原生、原生 HTML/CSS/JS、无；
- `backend`：Fastify / Express / FastAPI / Go + go-chi、Node.js 内置 http/https、Python 标准库 http.server、Python 采集脚本、无。

识别是启发式的：会忽略 `tests/`、`test_*.py`、生成的 `lextab/yacctab/parsetab.py`、`dist*` 目录；识别不到的项返回「无」。手动填写 `languages/frontend/backend` 会覆盖自动结果。远程应用不做识别。

实测边界（回答过用户「会不会影响应用运行/碰代码」）：探测期间 `/root/applications` 下**非 .git 文件零改动**，仅各仓库 `FETCH_HEAD` 更新。

### 7.3 远程健康探查

`fetch(healthUrl)`，6 秒超时（`AbortSignal.timeout`），解析见 §6.2；失败时 `error` 记录 HTTP 码 / 超时 / 连接错误，前端状态显示红色「未运行」。

### 7.3.1 外机项目目录 git 检查（2026-11-11）

对配置了 `gitDir` 的 `remoteApps[]` 条目（当前 network-monitor@netwatch、log-gpt-agent@lan-1103），每轮探测通过 **SSH 在外机上执行只读脚本**检查 git 同步状态，结果写入 `apps.json` 的 `git` 字段（结构同本机），前端同步列/卡片自动渲染，无需区分来源：

- **一次 SSH 跑完**：`cd <gitDir>` + `rev-parse` 仓库校验 → branch/repo(url) → `fetch --no-tags`（远端 git 用**远端自己的凭据与网络**；除远端机 `.git` 内的 FETCH_HEAD/refs 外不触碰任何文件）→ `status --porcelain` → `rev-list --left-right --count @{upstream}...HEAD`，用 `@branch@/@repo@/@fetch@/@st@/@count@/@end@` 行标记分段，Node 侧解析（输出缺 `@end@` = 被中断 → 视为瞬态失败）。`@fetch@` 值：`0` 成功 / `none` 未配置远端（视为成功，与本机 fetchRepo 对齐）/ `skip` 快速探测免 fetch（remoteOk=null）。
- **并发与重试**：并发默认 2（`PROBE_REMOTE_GIT_CONCURRENCY`）；连接失败/超时/输出中断按 **4s → 10s 退避自动重试**（共 3 次尝试），仍失败标 `status:'error'`（前端灰色「检查失败」，悬停看原因），**下一轮完整探测自动再试**。单次超时：含 fetch 60s / 仅 status 25s。
- **快速探测（--no-fetch）**：跳过远端 fetch 只查工作区与 ahead/behind（沿用上次远端快照，与本机语义一致），实测 2 台约 90ms；错误信息经 `remoteGitErr()` 提取 stderr 首行（不回显整条 ssh 命令行）。
- **SSH 细节**：`BatchMode + ConnectTimeout=8 + accept-new + ControlMaster/Persist=120`；配置 `gitKey` 时加 `-i <key> -o IdentitiesOnly=yes`（踩坑 #16：指定钥匙确定性）。与监控采集不冲突（agent 模式主机只是被动收 git 检查的 1 条短连接，非监控采集双路）。
- **线上机语义（2026-11-11）**：`env: 'public'`（公网服务器）视为线上机，检查结果带 `git.production: true`，前端同步列按线上口径显示——`synced`→绿「线上已同步」、`dirty`→红「线上已改 ×n」（违规：不允许线上改代码）、`ahead`→红「线上提交 ×n 未推送」（违规：不允许线上提交/push）、`behind`→橙「可拉取 ×n」（正常待部署）、title 注明「线上机（仅允许 pull，禁止线上修改与 push）」。当前 study-log-cloud（阿里云 `/root/applications/studylog`，main 分支）实测已同步。
- 实测：netwatch `/root/network-monitor` main 分支未提交 47、lan-1103 `/root/log_gpt_agent` VueRebuild 分支未提交 3、阿里云 studylog main 已同步；`github` 字段留空时由远端 repo url 兜底生成链接。 线上语义已在三份前端拷贝同步（`src/lib/app-utils.js`、`glass/assets/glass.js`、`glass-v2/assets/glass-v2.js`、`unslop/assets/app.js`）——**改 git 展示逻辑时四处都要改**。

### 7.4 输出 `apps.json` 结构

```jsonc
{
  "probedAt": "2026-11-03T00:43:17.259Z",   // ISO，探测完成时刻；前端用它判断探测是否已更新
  "page": { … },                            // 原样透传 apps.config.json 的 page
  "apps": [
    {
      "id": "study-log", "name": "…", "description": "…",
      "directory": "/root/applications/study-log",
      "port": 3000, "expectedPort": 3000, "extraPorts": [],
      "external": true,                     // 是否对外监听
      "status": "running",                  // running | down
      "kinds": ["web"],                     // 应用形式：web / app / miniapp / tv / cli
      "env": "lan",                         // 部署位置：lan | public
      "https": false,                       // 访问链接是否用 https（仅本机应用）
      "languages": ["JavaScript"],          // 主要语言（手动值或自动识别结果）
      "frontend": ["Vue 3", "Vite"],        // 前端框架
      "backend": ["Fastify"],               // 后端框架
      "github": "…", "tags": [], "icon": "📚", "pending": false,
      "git": { "status": "dirty", "repo": "github.com/…", "branch": "main",
               "uncommitted": 24, "untracked": 6, "ahead": 0, "behind": 0,
               "remoteOk": true, "checkedAt": "…", "message": "" },
      // 仅远程应用：
      "remote": true, "url": "…", "location": "阿里云", "host": "…",
      "remoteInfo": { "online": true, "httpStatus": 200, "responseMs": 86,
                      "version": "1.1.0", "dbReady": true, "rssMb": 78,
                      "uptimeSec": 1088946, "error": "", "checkedAt": "…" },
      // 仅离线应用（kinds 不含 web）：
      "appOnly": true
    }
  ]
}
```

> `git` 字段对未配置 `gitDir` 的远程应用为 `null`（配置了则同本机结构，checkedAt 随每轮探测刷新）；`appOnly` 条目（`kinds` 不含 `web`）的 `port` 为 `null` 且不做端口探测。

---

## 8. 前端实现要点

### 8.1 数据与状态（`src/App.vue`）

- `shallowRef` 存 `apps`，`page` 单独 ref（`watch(siteName)` 同步 `document.title`）
- 轮询 60s（静默模式不显示 loading）；`visibilitychange` 回前台立即刷
- `onSaved(savedAt)`：设置保存后先刷一次，再每 1.5s 轮询直到 `probedAt > savedAt`（上限 40 次）→ 再刷一次
- `syncNow()`：「立刻同步」按钮 → `POST /api/probe` → 每 2s 轮询直到 `probedAt > 服务端 startedAt`（上限 90 次）→ 刷新；期间按钮禁用并显示「同步中…」
- 页脚「最后探测」固定按 `Asia/Shanghai` 显示（避免浏览器时区不同导致偏差）
- **两视图共用页头与顶栏入口（2026-11-10）**：应用中心与监控中心都用 `PageHero.vue`（同一 `.hero` 结构：标题/副标题/统计 chip），切换时标题与统计区零位移；顶栏齿轮**常驻**，按 `topView` 打开应用设置或监控设置（原监控视图齿轮隐藏导致右侧图标横移、旧 `.mon-hero` 紧凑版导致内容上跳，均已修复）；`.brand-tab` 两档统一 `font-weight:600`，避免激活态字重变化造成标题宽度抖动；`html, body` 加 `scrollbar-gutter: stable`，避免长/短视图切换时滚动条出现导致整页横向抖动。
- 三视图状态：`view: 'table' | 'card'`（移动端 `≤760px` 默认卡片，用户手动选过后尊重其选择）

### 8.2 排序（两种机制并存）

| 机制 | 入口 | 存储 |
|---|---|---|
| **手动排序**（`sortKey === 'default'` 时可用） | 表格行首 ⠿ 手柄拖拽 / 卡片左侧手柄拖拽 / 卡片 ↑↓ 按钮 | localStorage `my-homepage:appOrder`（**仅本浏览器**；新应用自动排末尾；工具栏 ↺ 清除） |
| **自动排序** | 表格表头点击（状态/应用/访问地址/同步，再点切方向）/ 工具栏下拉 | 不持久化 |

自动排序键：`name`（中文拼音 `localeCompare('zh-Hans-CN')`）、`port`（升序，未监听排后）、`status`（运行中 → 未运行 → 离线应用）、`git`（按问题严重度：dirty → no-repo → ahead → behind → untracked → error → no-upstream → synced）。

**拖拽只从手柄触发**（`draggable` 只加在手柄元素上，行/卡片本身不可拖）——用户明确要求过，点击卡片不该出现拖拽效果。

### 8.3 视觉规范

- 设计变量集中在 `src/style.css`：浅色为默认，`html[data-theme=dark]` 为 GitHub Dark 配色；主题存 localStorage `theme`，支持 `auto` 跟随系统
- **本机 = 蓝（`--accent`） / 外机 = 绿（`--green`） / 公网 = 橙（`--amber`）**，四种呈现同时生效：名称旁 `env-chip` 标签、表格行 `td:first-child` 左边色条、卡片左边框、应用图标底色（`icon-ext` / `icon-net`）。归属由 `appScope()` 判定：`apps[]` → 本机；`remoteApps[]` 的 `lan` → 外机、`public` → 公网
- **应用形式 chip**：`kind-chip`（Web / APP / 小程序 / 电视 / CLI，可多选），按类型配色：Web 蓝、APP 绿、小程序青、电视紫、CLI 灰；表格显示在名称下方标签行，卡片显示在底部标签行
- **技术栈文本**：表格在应用形式 chip 后显示最多两行 `语言 · 前端 · 后端`，在应用列固定宽度内垂直居中，超出两行省略、悬停看完整；卡片有独立「技术栈」行
- **业务标签 `tags`**：仍保存在配置与设置页中，但当前不在首页表格/卡片展示（避免与形式/技术栈重复）
- 状态徽标：**运行中（绿）/ 未运行（红）/ 离线应用（灰）**；远程应用同样统一为运行中/未运行，离线应用为纯 APP / 小程序 / 电视 / CLI、不做探测
- git 同步 chip：已同步绿、未提交红、未推送/未拉取/未跟踪橙、无仓库等灰
- 表格布局：容器 `max-width: 1440px`；行内容 **`vertical-align: middle`**，表头 **`text-align: center`**；应用列固定 `width/min-width: 340px`；简介列 `-webkit-line-clamp: 3` + 固定 `height: 63px`；`.app-meta` 同为 63px（名称行 + 两行技术栈约 60px）→ **每行高度严格一致**（约 92px）
- 移动端 `≤640px` 单列，`≤900px` 表格压缩列宽并横向滚动

### 8.4 设置面板（`src/components/SettingsPanel.vue`）

`Teleport` 到 body 的模态框，三区块：页面信息 / 本机应用 / 云服务器应用。**应用区块是紧凑列表**（每行：图标 + 名称 + mono id + 摘要行「应用形式 · 部署位置 · 端口/主机」，右侧 ›，加「新 / 已隐藏」标记；标题栏带计数与「＋添加」），**点击条目弹出嵌套编辑弹窗**（z-index 60 盖在面板上，含全部字段；底部「删除此条目」需 confirm，「完成 / ✕ / 点遮罩」关闭）。**新增**按钮直接创建空条目并立即打开弹窗。弹窗内修改均为**草稿**（直接改 form 里的响应式对象），仍由面板底部「保存」一次性 POST `/api/config`，保存语义不变（见 §8.1 `onSaved`，保存后立即关闭，探测在后台跑）。字段能力不变：**应用形式**（`kinds` 多选）决定是否探测（勾 Web 才探测）、**主要语言 / 前端框架 / 后端框架**（逗号分隔）、**部署位置**（`env`）、本机应用另有 **使用 HTTPS** / `exclude`；本机技术栈留空用自动识别（保存后变手动值），远程需手填；「期望端口」旁显示实际探测端口，不一致时点「采用」写回。缺省值在面板加载时自动补全（本机 `lan`、远程 `public`；旧 `type: "app"` 回退 `["app"]`）。注意：`mini-btn` 曾只在 AppCard 的 scoped 样式里定义（面板按钮无样式），2026-11-07 起面板自带文字按钮样式。**双向同步（2026-11-11）**：远程应用编辑弹窗底部有「同步到监控中心」勾选（`monitorSync`，外机/公网列表行加「已同步监控 / 来自监控」徽标）；本机应用弹窗显示禁用勾选「监控自动跟踪」（本机目录本来就自动并入监控，无需勾选）。机制见 §17。

### 8.5 独立毛玻璃页面（`glass/`，访问 `/glass/`）

完全独立于 Vue 主站的静态页面，纯 HTML + CSS + JS，**不参与 Vite 构建、不依赖任何第三方库**；布局与信息层级完全沿用主站，仅把视觉换成毛玻璃。

- 入口 `glass/index.html`，样式 `glass/assets/glass.css`，脚本 `glass/assets/glass.js`；全部类名/变量/存储键使用 `fg-`、`--fg-`、`fluxglass:*` 命名空间。
- 布局：顶栏（品牌 / GitHub / 设置入口 / 主题）、Hero + 4 个统计 chip、工具栏（排序下拉 + 方向/重置、表格/卡片切换、立刻同步）、表格视图（拖拽手柄 / 状态 / 应用 / 简介 / 访问地址 / 服务器目录 / 同步 / GitHub）、卡片视图、页脚。与 `src/App.vue`、`AppTable.vue`、`AppCard.vue` 的结构一致。
- 数据：`fetch('../apps.json')`（经 nginx 即 `/apps.json`），每 60 秒刷新 + 回到前台刷新；统计、表格、卡片均为真实应用数据，无演示指标。
- 交互：表头/下拉排序、正倒序、手动拖拽排序（localStorage `fluxglass:appOrder`，与主站 `my-homepage:appOrder` 独立）、表格/卡片切换、目录点击复制、`立刻同步`（POST `/api/probe` 并轮询 `probedAt`，与主站同逻辑）、主题切换（`fluxglass:theme`）。
- 视觉：环境层径向渐变光斑 + 噪点颗粒，表格/卡片/顶栏用 `backdrop-filter: blur(22px) saturate(165%)`、半透明渐变、内高光与多层阴影；含浅色 / 深色主题。
- 响应式：≤760px 默认卡片视图（与主站一致），表格横向滚动，≤760px 模糊半径降至 16px；`prefers-reduced-motion` 下关闭光斑漂移与入场动效；不支持 `backdrop-filter` 时降级为高不透明度背景。
- 部署：`deploy.sh` 的 `rsync --delete` 只覆盖 `www/`，**不会删除 `glass/`**；nginx 在两处 server 块各加了 `/glass/` location（`root /root/applications/my-homepage` + `try_files … /glass/index.html`）。改完无需构建，刷新即生效。
- 视觉净化（2026-11-06，unslop polish 模式，毛玻璃特质全部保留）：① 修复 `.fg-body button` 重置（特异性 0-1-1）压过单类按钮组件（0-1-0）导致**主题按钮 / 立刻同步 / 卡片↑↓ / 重试的玻璃底与边框整体失效**的问题——重置不再写 border/background，`.fg-segmented button` 自带 `border:0; background:transparent`；② 表头去 `uppercase + letter-spacing`（GITHUB → GitHub，11.5px → 12px）；③ brand mark 蓝→紫渐变 tile + 彩色 glow 改为主站同款**纯色 flat mark**；④ 分段控件选中态蓝色渐变 + 彩色 glow 改纯色；⑤ 非标准字重 650/550 统一为 600；⑥ 卡片入场动画只播一次（`state.cardEntered` + grid 级 `fg-noenter` 抑制类），修复**每 60s 轮询重建 DOM 整片重播入场动画**的闪烁；⑦ 用户反馈后二次调整：环境光斑**去除紫色相、全部收敛为蓝色系（科技蓝）**（`--violet`/`--indigo` 类名沿用历史位置命名，实际色值已为蓝/靛蓝），浅色 wash 渐变同步偏蓝；次级/弱文字对比度调高（`--fg-text-2` 0.64→0.8、`--fg-text-3` 0.48→0.62；dark 0.68/0.5→0.78/0.6），修复「简介等字体不黑看不清」。

### 8.6 独立设计对比端点（`unslop/`，访问 `/unslop/`）

主站首页的**净化对比版**：在旧页面视觉的基础上只做轻度优化（v2，2026-11-06）。首版曾按「机房仪表盘」重新设计（机架面板/首字字块/mono 键帽），用户反馈「还没有原来的好看，在旧页面的基础上优化即可」后重写为 v2 —— **视觉 1:1 移植主站**（`src/style.css` 全套变量与组件、`AppTable.vue`/`AppCard.vue` 的 scoped 样式原样并入，emoji 图标、彩色 chips、行色条、hero 统计胶囊全部保留），旧主页完全未动。

- 形态：与 `glass/` 同模式的独立静态页（`unslop/index.html` + `assets/app.css` + `assets/app.js`），纯 HTML/CSS/JS、零依赖、不参与 Vite 构建；类名与主站相同（`topbar/hero/stat-chip/app-table/card…`，无前缀，便于 diff），存储键 `unslop:appOrder` / `unslop:theme`。
- **与主站的全部差异（仅 4 处，写在 app.css 头部注释里）**：① 表头去掉 `uppercase + letter-spacing`（GITHUB → GitHub，仍居中）；② 所有 `transition: all` 改为枚举属性；③ `.hero h1` 字重 700 → 600；④ 补 `:focus-visible` 焦点环、`[hidden]{display:none!important}` 兜底、`prefers-reduced-motion` 降级。
- 功能与主站对齐：同一份 `apps.json`（60s 轮询 + 回前台刷新）、表格/卡片双视图（≤760px 默认卡片）、表头/下拉排序 + 正倒序、手柄拖拽手动排序 + ↺ 重置、目录点击复制（含 execCommand 回退，http 局域网必需）、立刻同步（POST `/api/probe` + `startedAt` 轮询）、深浅主题。**设置入口链接回主站 `/`**（沿用 glass 先例，本端点只读）。页脚无「Powered by Vue」（静态页非 Vue）。
- 维护：改 `unslop/**` 刷新即生效；**主站视觉/`apps.json` 字段结构变化时需同步 `unslop/assets/app.js` 与 `app.css`**（加工逻辑复制自 `src/lib/app-utils.js`，两处并存）。若决定采纳某处优化，把对应改动搬回 `src/` 重新构建即可；确认弃用后删除目录并撤销两处 nginx location。
- nginx：`/unslop` → 301 → `/unslop/`，两处 server 块各一个 location（`root /root/applications/my-homepage` + `try_files … /unslop/index.html` + no-cache），备份 `*.bak-unslop-20261106`。
- 踩坑：Vue 模板习惯的自闭合 `<div />` 在原生 HTML 里是**未闭合标签**，曾把 footer 吞进 `#u-content` 内部，首次 `innerHTML` 渲染将其销毁、`renderPageText` 抛错中断整个渲染（见踩坑 #11）。

**目录维度与进程表（2026-11-10 用户反馈）**：目录占比图类目标签**不再追加 `⬛` 容器标记**（用户要求删掉黑色方格；容器归属仍可由「容器 xxx」名称与进程表「容器」列辨认）。**进程明细表头全部可点击排序**：`PROC_COLS` 定义 11 列，数字列默认降序、文本列默认升序，再点同列切换方向，当前列高亮 + ↑/↓ 指示，空值始终排最后（默认 CPU% 降序，替代原先硬编码排序）；**排序列箭头固定占位 11px**（`.sort-arrow`），避免切换排序列时各列宽度/位置左右移动。目录指标下拉 `.mini-select` 与目录 chip 复选框均改为自绘样式（胶囊 + SVG 箭头 / 13px 方框 + 勾），不再使用浏览器原生灰控件。**主机卡副标题**由 `hostSubtitle()` 统一生成：`<核心数>核 <CPU型号> · <内存>GB · <磁盘>TB/GB · <操作系统>`（CPU 型号取 `snap.os` 中 ` · ` 后的部分并去掉 Hygon C86 / Intel Xeon 前缀与 Processor 后缀；磁盘为各非虚拟分区 totalGb 之和，≥512GB 显示 TB；本机内核串含 `ky10` 时操作系统显示 Kylin V10；完整文本放 title）。

**详情布局与按钮体系（2026-11-10 按用户反馈重做）**：详情页 = 4 趋势图一行 → 目录占比**全宽**（分区用量图已按用户要求删除，分区占用保留在主机卡磁盘圆环）→ 目录历史对比 → 进程明细；**无跟踪目录的主机**（netwatch/aliyun/113）目录占比与对比盒整体收起、显示一行占位指引（守卫 elDirs/elCmp 为 null 的 echarts.init 崩溃）。按钮统一**软胶囊两档**（强调蓝 accent-soft / 中性灰 bg-hover），去 ⌨/✕ emoji；时间窗为分段控件（bg-hover 槽 + 白色浮起选中）；趋势图**不画阈值参考线**（用户明确要求去掉 CPU 85% 红色虚线，2026-11-10 已从主站与 glass-v2 一并移除；阈值仍用于告警判定与设置）；**纵轴自适应**：`baseOption` 的 value 轴统一 `scale: true`、不再固定 `max:100`；CPU 与内存各用**单轴单曲线**（2026-11-10 用户要求移除「负载」「Swap」两条辅助曲线及左右双轴，避免多轴/多色难懂），网络/磁盘用轴名标注单位 `Mbps` / `MB/s`（轴名放 `nameLocation:'end'` 顶部，避免数值标签加单位后挤压绘图区）；**每张趋势图显示图例**（`CPU %` / `内存 %` / `下行/上行 Mbps` / `读/写 MB/s`），颜色与单位一目了然；资源趋势标题旁有「曲线颜色见各图图例 · 纵轴按所选时段的峰值自适应」提示；**CPU 图头直接显示「当前 X% · 峰值 Y%」**，解释自适应纵轴为何到 30%（用户质疑 NetWatch 左轴数据时核对：当前 3.5%、峰值 27.4%，与目标机 `top` 的 3.2% 一致，峰值时刻负载 1.12 / 内存 63%→75%，为真实事件），tooltip 数值统一带单位（`%` / `Mbps` / `MB/s`）。主机卡圆环根因：`@property --v` 必须 `inherits: true`（见踩坑 #19）。

**批量终端（2026-11-10）**：`MonitorBatchTerm.vue`——监控工具栏「批量终端」→ 主机多选器（仅 credReady 主机，**最多 6 台**）→ 多窗格并排；**命令栏一条输入广播到全部窗格**（`text+\r` 逐 WS 下发），点击某窗格进入**单机交互**（密码/交互式提示，命令栏同步切单机语义），「返回广播」切回；布局规则：≤3 台一行并排、≥4 台两行×3 列（`gridTemplateColumns` 动态）；支持全屏切换、每窗格独立重连/状态点。主机多选器为居中模态（遮罩 + 可选行卡片 + 选中蓝底 + 主按钮；`.batch-picker*` 样式在 MonitorView scoped 内，曾因只有结构没有样式退化成页面底部一排裸控件，2026-11-10 补齐）。翻页：滚轮原生可用；PageUp/PageDown 在普通缓冲区下拦截为 `term.scrollPages()`（命令栏聚焦时广播翻全部窗格，点击某窗格后只翻该窗格；vim/less 等备用屏不拦截、交还应用）；xterm viewport 加 `scrollbar-gutter: stable` + 细滚动条样式（默认 overlay 滚动条宽度 0、无法拖拽）。每窗格即一条普通 WS 会话（走既有网关，审计天然覆盖，注意 `maxSessionsPerHost`（当前 10）的并发上限）。glass-v2 同款（vanilla 实现，xterm 用 vendor 全局 `Terminal`/`FitAddon.FitAddon`）。

**终端多会话缓存（2026-11-10）**：抽屉关闭（遮罩 / ESC / ✕）只隐藏，不关 WS；`MonitorView` 用 `termTabs[]` 缓存最多 **8 个会话**（**同一主机可多开**，点页签栏「＋ 新会话」；LRU：最近使用排末尾，超出淘汰最久未用且非当前页签），每个会话渲染一个常驻 `MonitorTerm`（`v-show` 只显示当前，页签 key 为 `hostId:seq`，状态点按 key 记录），页签条带状态点（绿 / 红 / 灰）并支持切换与 × 结束；同一主机多会话时页签追加稳定序号 `#n`（存于 `ordinal`，不随切换重排）；「结束会话」释放当前页签（组件卸载 → `onBeforeUnmount` 关 WS、释放 xterm）。切换会话不重连，历史输出与 shell 现场保留；后台会话受网关空闲超时限制（当前 8 小时），超时后页签变红、内容保留，点「重连」恢复。弹出窗口前主动释放当前页签会话，避免重复占用（每主机并发上限 10）。glass-v2 仍为单会话。

**终端交互打磨（2026-11-11，用户五条反馈）**：① **渐进宽度**——抽屉按窗格数 `w1/w2/w3` 三档：1 格 `clamp(420px, 33.33vw, 720px)`、2 格 `clamp(780px, 66.66vw, 1440px)`、3 格及以上 `calc(100vw - 56px)`（左侧留遮罩空白可点击退出），`transition: width 300ms` 与窗格 FLIP 叠加；`:not(.full)` 防止覆盖全屏档。② 标题栏 `.mon-term-head` 补齐 flex-wrap + `padding: 10px 14px 0`（此前完全无样式，标题贴边被裁），`.host-chips` 改 `flex-basis:100%` 独占第二行。③ **关闭语义拆分**——✕ 按钮 → `closeTermAll()`（清空全部窗格/状态/提示，下次打开为全新单窗格）；遮罩点击 / ESC → `hideDrawer()` 保留现场。④ `MonitorTerm` 加 **ResizeObserver**（rAF 节流、`props.visible` 门控）→ 容器尺寸变化自动 `fit()` 并经 `onResize` 同步 pty 列行数，窗口缩放/抽屉变宽时内容重排跟手。⑤ `endPane` 聚焦修正为相邻幸存窗格（原实现在窗格删除后聚焦已删 key）。**滚轮 4+ 窗格「失效」未复现**：4/6 窗格窗口态+全屏态、批量 4 台实测 scrollTop 均正常变化（1083→283 等），判定为浏览器缓存旧版 JS，强刷即可。验证：`.verify/e2e-term-ux5.mjs`（17 断言）；e2e-multipane 步骤 6 改 ESC 验保留、新增步骤 10 验 ✕ 清空（22 断言）。

**自动纳管（2026-11-10，一键零手工）**：设置页主机弹窗「自动部署」区输入**目标机密码** → `POST /api/monitor/hosts/provision` → 中心 SSH（密码认证）一次 exec 完成：写 authorized_keys（监控专用 ed25519）+ 直灌 agent 安装器（不用 curl/HTTP，无对外依赖）→ **key 认证复验免密** → 落盘 keyPath + mode=agent → 密码 AES-GCM 加密存档备用；返回逐步日志给 UI。实测 netwatch 清零点全流程 **1.1 秒** 6 步完成，之后监控零 SSH 连接、终端照常、目标机 25 个既有服务未受任何影响。CLI 等价：`node scripts/monitor-server.mjs --agent-install-cmd <hostId>`（需先有密钥）。坑：`saveConfig()` 末尾会 `loadConfigSync()` 重建 `config.hosts`，**跨保存持有主机对象会写到游离对象上**（曾导致 keyPath/mode 丢写）→ 每次都 `upsert()` 重定位再改；免密复验连接必须 `end()`（否则 keepalive 长期挂起，实测残留 1 条 ESTABLISHED）。

**Agent 推送模式（2026-11-10）**：`hosts[].mode: 'agent'` 切换——目标机常驻零依赖 sh agent（采集代码与 SSH 探测**同源**，指标口径一致），每 20s `curl POST /api/monitor/agent/push`（X-Agent-Token 鉴权，token 存 credentials.json agents 段，CLI/凭据库 fs.watch 热同步）；中心复用 parseRemoteOutput→buildSnapshot 管线，**监控零 SSH 连接**（终端仍 SSH）；推送断流 >70s 看门狗判离线。一键安装：`GET /api/monitor/agent/install.sh?token=`（token 门禁）返回自带采集器/systemd 单元的幂等安装脚本（无 systemd 兜底 nohup+cron）；设置页主机弹窗「采集方式=Agent 推送」可生成/复制命令，CLI `--agent-install-cmd <hostId>` 同效。适用内网可达中心的机器；**公网不可内连的主机（如阿里云）保持 SSH 拉取模式**（中心 20s 短连接外连采集，即当前定制方案）。netwatch 已实测切换（推送驱动/掉线告警/恢复/终端不受影响）；目标机单元名 `my-homepage-agent.service`，push URL 走 nginx `/api/monitor/agent/*`（8301 仅回环）。设置页主机弹窗含「采集方式」下拉与安装命令生成/复制；CLI `--agent-install-cmd <hostId>` 同效。

### 8.8 毛玻璃 v2 对比端点（`/glass-v2/`，2026-11-10，unslop skill 产出）

应用导航 + 监控中心**双视图**的毛玻璃对比版（用户点名「毛玻璃、好看、炫酷、保留现页对比」），纯 HTML/CSS/JS 零构建，结构上 = `/glass/` 的设计语言 × 主站 SPA 的双视图功能：

- **方向**（unslop 五行）：个人服务器控制台；夜航仪表、冷静、透亮；机房夜色（深蓝黑 + 科技蓝光斑 + 噪点，暗色默认、浅色玻璃可切）；时刻=玻璃仪表环与彩色图表曲线；签名=呼吸状态点（`.gv-dot.is-live` 涟漪，在线/告警等活体指示，reduced-motion 关闭）。
- **功能对齐主站**：双 tab 同页切换（localStorage `gv2:view` + `#monitor` hash）、表格/卡片/排序/拖拽/复制目录/立刻同步、监控 5s 轮询 + 内联详情（4 趋势图/分区/目录占比/目录对比/进程明细）+ 告警横幅 + 设置弹窗（含改密/审计）+ xterm 终端抽屉（弹窗放大复用 `/monitor/terminal.html`）。会话 Cookie 与主站共享——主站登录过此处自动鉴权。存储键 `gv2:appOrder` / `gv2:theme` / `gv2:view`。
- **unslop 纪律**：4px 网格；三级文字角色；chrome 无 emoji（sprite SVG 图标，应用 emoji 图标属数据保留）；动效只走 transform/opacity + `@property --v` 注册的仪表环插值；入场动画仅首次（`state.entered` 同 glass 踩坑 #6 教训）；`prefers-reduced-motion` 全降级；≤760px 模糊降至 16px；`@supports` 无 backdrop-filter 时升级面板不透明度。
- **文件**：`glass-v2/index.html` + `assets/glass-v2.css` + `assets/glass-v2.js`（应用逻辑移植自 `/unslop/` 成熟实现，监控逻辑移植自 git 历史版 monitor.js）+ `assets/vendor/`（echarts/xterm 自包含——**不要跨端点引用 /monitor/assets/vendor**，echarts.min.js 已在 SPA 化时从那里删除，会落 try_files 兜底返回 HTML）。
- nginx：两处 server 块各一个 `/glass-v2/` location（`root` + `try_files`），备份 `*.bak-glassv2-20261110`。
- 踩坑：`.gv-gauge` 忘写 `position: relative` → `::after` 内圆孔与 `.gv-gval` 数值锚到卡片上漂移；自定义属性过渡必须 `@property` 注册。
- 顶栏标题防跳（2026-11-10）：激活 tab 的呼吸点 `::before` 曾只加在 `.gv-tab.is-active` 上，导致激活 tab 比非激活宽 15px（103 vs 88），切换时两个标题左右跳。改为 `.gv-tab::before` 常驻占位 + 非激活 `visibility:hidden`；两 tab 固定同宽，实测 x 坐标切换前后一致。
- 页面宽度防抖：`html, body { scrollbar-gutter: stable }`（主站 `src/style.css` 同步加），避免应用列表（长页）与监控（短页）切换时滚动条出现/消失造成整页横向位移。
- **与主站的同步状态（2026-11-10；2026-11-11 更新）**：目录历史对比默认全选 + 全选/清空（`state.seededDirs`、`#gv-cmp-all/#gv-cmp-none`）**已同步**；主站主机设置改紧凑列表 + `MonitorHostEdit.vue` 双通道后，此端点的设置弹窗**布局未跟进**（仍为主机平铺表单版），但功能层面已在 SSH 主机表单补上「同步到应用中心」勾选（`data-k="appSync"`，见 §18.3）——如需布局对齐，照 `glass-v2.js` 既有「渲染函数 + addEventListener」模式移植，勿引 Vue。

### 8.7 监控中心与 Web 终端（并入主站 SPA，2026-11-10；首版为独立 /monitor/ 页，同日按用户反馈合并）

选型结论：**自研轻量网关**（Node 直读 `/proc` + ssh2 免 Agent 远程采集）而非 Prometheus/Grafana/Netdata——决定性理由是「**按目录归属进程资源**」这一核心诉求在成熟方案里都是 cmdline 模板分组（不支持 cwd 维度），而 cwd 归属自研只要几十行；Web SSH 选 **xterm.js + ssh2** 而非 ttyd/Wetty/GateOne（pty 直通架构无法做会话鉴权/凭据加密/审计；GateOne 已停维护）。完整对比表与架构见 `docs/monitor-terminal-blueprint.md`。

**形态（2026-11-10 用户反馈后定稿）**：监控看板**不再是独立页面**——主站顶栏是双标题「应用中心 / 监控中心」（`.brand-tabs`，active 高亮胶囊，点击切换 `topView`，localStorage `my-homepage:topView` 持久化 + `#monitor` hash 直达；2026-11-10 由「我的应用」改名——标签 1 即 `page.heroTitle`，改名改该配置字段即可，glass-v2 标签为硬编码需同步）。active 高亮胶囊，点击切换 `topView`，localStorage `my-homepage:topView` 持久化 + `#monitor` hash 直达）。两视图均**常驻 `v-show`**（不用 KeepAlive，原因见踩坑 #17），`MonitorView` 接收 `active` prop 自管「boot / 轮询启停」。首版独立静态页已退役：`monitor/index.html` 只剩重定向 stub，`monitor/terminal.html`（终端弹窗放大页）保留。

**组件结构**：`MonitorView.vue`（hero 统计胶囊 + 告警横幅 + 主机卡 grid；登录层已上移至 App.vue 全站门禁）→ `MonitorDetail.vue`（点卡片**内联展开**：4 趋势图一行 / 目录占比 + 目录对比 / 进程明细全宽，独立加载 history+procs，15s 自刷；详情头部 ⚙ 打开该主机的设置弹窗；**目录历史对比默认全选**——`seededDirs` 记录已补勾路径，只补新目录、自刷不重置用户手动取消项，标题旁有全选/清空按钮）→ `MonitorSettings.vue`（设置弹窗，**纳管主机为紧凑列表**：点击行弹出嵌套 `MonitorHostEdit.vue` 编辑弹窗）与 `MonitorTerm.vue`（终端抽屉 + 弹窗放大 + **全屏/还原切换**：原地铺满视口并同步 pty 列数，ESC 先还原窗口再关闭——捕获阶段监听，因 xterm textarea 会吞冒泡阶段的 Escape）。图表走 `src/lib/monitor-charts.js`（**echarts/core 按需注册**，动态 import → 独立 chunk 180KB gz，不占首屏；主包 56KB gz 基本不变）；xterm 同样动态分包（73KB gz）。

**主机设置双通道**（2026-11-10）：`MonitorHostEdit.vue` 是单主机编辑弹窗的共享组件（表单 + 该主机跟踪目录 + 凭据提示），两种模式：① **草稿模式**（设置面板进入）——面板「纳管主机」区为紧凑列表（图标 + 名称 + mono id + 摘要行「类型 · 分组 · 地址:端口 · N 个跟踪目录」+ 本机标「内置」），点击行弹嵌套弹窗（z-index 80 > 面板 70），修改直接改 cfg 里的响应式对象，仍由面板底部「保存配置」统一 PUT；「＋添加主机」创建空条目并立即打开弹窗。② **直连模式**（详情页 ⚙ 进入）——`MonitorView` 拉全量配置深拷贝出目标主机，弹窗底部「保存」直接 PUT 整份配置（其余段原样带回），成功后刷新 summary；服务端校验错误（如 SSH 缺 address）就地显示在弹窗内，不改配置。删除主机只在草稿模式弹窗提供（confirm 后删草稿行，保存生效）；本机主机不可删。**跟踪目录展示（2026-11-10 用户反馈「本机显示空、全局区重复」）**：`GET /api/monitor/config` 给每台主机附带只读 `effectiveDirs`（`effectiveTrackedDirsFor`：全局 + 本机主页登记 + 该主机自有，**再追加运行时自动发现的容器目录 `source:'container'`**；PUT 时 `normalizeHost` 丢弃不落盘）；主机弹窗把「自动并入」目录以虚线行 + 「主页登记 / 全局 / 自动发现」chip 只读展示（容器行显示 `name` 如「容器 open-webui」，title 放原始 path），自有目录可增删；添加时若路径已在 `effectiveDirs` 中会拦截重复。本机因此显示 9 个主页登记 + 1 个容器 = 10，与主机卡/图表一致。设置面板的全局「跟踪目录」区改为 **仅当 `cfg.trackedDirs` 非空时显示**，标题「全局自定义目录（对所有主机生效）」并注明通常无需在此添加，避免与每主机目录重复。

**双向同步勾选（2026-11-11）**：`MonitorHostEdit.vue` SSH 主机表单在「采集方式」下新增「同步到应用中心」勾选（`hosts[].appSync`，`normalizeHost` 白名单放行），勾选后由 settings-server 自动在应用中心维护同 id 远程应用；主机行摘要随之显示「来自应用中心 / 同步到应用中心」徽标（`syncSource`）。机制、回环防护与删除语义统一见 §17。

**架构**：`monitor-server.mjs`（systemd 常驻，`127.0.0.1:8301`，依赖 ssh2+ws）同时承载 HTTP API 与终端 WebSocket；nginx **两处 server 块**各加三个 location：`/monitor/`（静态 stub+终端页）、`/api/monitor/`（反代）、`/api/terminal`（WS 升级，read_timeout 3600s）。备份 `*.bak-monitor-20261110`。echarts/@xterm 已移入 dependencies（SPA 打包需要），主站「前端零第三方运行时依赖」的说法仅对**首屏主包**成立。

**采集与目录归属**：
- 本机 5s 直读 `/proc`（cpu/meminfo/loadavg/net.dev/diskstats/statfs/每进程 stat+status+io+cwd+exe+cmdline+cgroup）；远程 20s 经 ssh2 `exec('sh -s')` 注入一段 POSIX sh 脚本（单个 awk 吃掉全部 procfs + 内建解析 cwd/fd，零逐进程子进程），输出**计数器口径**，网关差分算速率。
- 目录归属四路优先级：cwd → exe → cmdline 含路径 → cgroup 容器（compose label `working_dir` 命中则并入目录组，否则按 `容器 <name>` 单列，docker 映射每 30s 刷新）。**每主机跟踪目录**：`hosts[].trackedDirs[]`（⚙ 设置内每台主机可添加，2026-11-10 加）——远程主机借此获得目录级资源统计；归属集 = 全局 trackedDirs + （仅本机）主页登记目录 + 该主机目录；远程探测已补 cmdline 采集（第二遍 awk，RS='\0'），远程归属靠 cwd+cmdline（无 exe）；目录默认名对 server/bin 等通用名自动取「父目录/名」避免重名。**未命中跟踪目录的进程不入库不出接口**（/proc 枚举仅用于归属判定，不越界采集）。
- 跟踪目录 = `monitor.config.json` 的 `trackedDirs[]`（自定义）∪ **主页 `apps[].directory` 自动并入**（source: homepage）——在主页登记过应用就自动被跟踪，零重复配置。
- 主机凭证：推荐密钥（`data/monitor/keys/<id>` 0600 + 目标机 `ssh-copy-id`）；密码凭据 AES-256-GCM 存 `credentials.json`（主密钥 `.secret` 0600）。SSH 主机指纹 TOFU 校验（首连记录，变更拒绝，`credentials.json` 删 `hostFp` 可重置）。
- 远程主机密钥分发需人工输一次密码：`ssh-copy-id -i data/monitor/keys/netwatch.pub root@10.8.14.200`（aliyun 同理）；分发后 ≤20s 自动转 ONLINE，无需重启。

**存储与告警**：内存环形 5s×1h + 1min 降采样×24h；分钟点落 `data/monitor/history/<hostId>/<日期>.jsonl`（默认保留 7 天，重启回放恢复）。告警阈值（CPU 85/内存 90/磁盘 90/每核负载 2，持续 3 分钟，超阈值+10 或 95% 升级 crit）→ `alerts.jsonl` + webhook（可配）。审计 `audit.jsonl`：登录（含失败限速 5 次/分）、会话开/关（含命令行捕获——按回车切行 best-effort，不录全键盘流）、配置/凭据变更。

**终端网关**：WS `/api/terminal?host=<id>` 升级时校验 HttpOnly 会话 Cookie + Origin 同源；ssh2 shell pty 桥接，支持 resize 控制帧（`{type:'resize'}`）；空闲 8h / 单会话 12h 硬顶 / 每主机并发 10（均可配，改动仅对新会话生效）。前端抽屉（`MonitorTerm.vue`，多会话页签）+ 独立弹窗页（`monitor/terminal.html?host=`）。命令白名单对全交互 PTY 不可靠（诚实边界），更强约束在目标机侧做（sudo 白名单/rbash），见蓝图 §5.5。

**滚轮滚动链守卫（2026-11-11，用户实测反馈「终端里滚轮带动背后页面滚动」）**：双保险修复——① 终端各覆盖层（SPA 抽屉+遮罩 / `MonitorBatchTerm` 批量层 / 独立终端页 `.term-page` / glass-v2 的 `#gv-term-mask`、`#gv-term-drawer`、`#gv-bt`）挂非被动 `wheel` 监听直接 `preventDefault()`，冒泡阶段晚于 xterm 内部监听，自身回滚不受影响；② 各 `.xterm-viewport` 加 `overscroll-behavior: contain`，滚到回滚边界不再外溢。验证：`.verify/e2e-wheel-guard.mjs`（8 断言：背后页面 scrollY 不动 × 5 处 + xterm scrollTop 正常变化）。注意独立终端页容器是 `class="term-page"` 无 id，别用 getElementById。

**鉴权**（2026-11-10 按用户要求放宽并升级为全站门禁）：独立访问密码（scrypt，只存哈希于 `data/monitor/.password-hash` 0600，配置文件不保存任何密码材料）；**无密码复杂度规则**（非空即可）。会话 **365 天滑动有效期并持久化到 `data/monitor/sessions.json`**（0600，关停 flush / 每分钟落盘 / 启动回放）——**同一浏览器登录一次后长期免密**：网关重启、改密均不掉线，只有主动 logout 或 cookie 丢失才需重登；Cookie `Max-Age` 与 TTL 同步（1 年）。改密保留既有会话。除 `login`/`healthz` 外全部 API 需会话；写操作另需 `X-Requested-With: XMLHttpRequest`（CSRF 双保险）；登录失败限速 5 次/分保留。**全站门禁**：App.vue 启动时检一次会话（401 → 登录层覆盖整个主页两视图；掉鉴权中途经 `unauth` 事件重现），glass-v2 加载即同检；网关不可达/502 时 **fail-open 放行**，不把主页锁死（stop.sh 场景）。CLI：`--set-password-stdin`、`--set-cred <hostId> --password-stdin`。

**前端视觉**：白底（`--bg-soft #fff`），变量与 `src/style.css` 完全同源（`--accent #2563eb` 主蓝，深色为可选项，默认浅色）；内网蓝/公网橙沿用。动效（全部 `prefers-reduced-motion` 降级，只动 transform/opacity/box-shadow）：数字 rAF 滚动 260ms easeOutCubic、卡片 hover 抬升 160ms `cubic-bezier(.2,.8,.2,1)`、告警点脉冲 2s、ECharts smooth 0.3 + 渐变面积 + `animationDurationUpdate 300 cubicOut`、入场 fadeUp stagger 仅首次（`state.entered` 标记，同 glass 踩坑 #6 教训）、骨架屏 shimmer、brand mark 扫光一次。

**布局重排（2026-11-10，对照 1Panel 诊断后）**：用户反馈「1Panel 布局好看，我们的总感觉有点奇怪」。诊断结论：hero 三层堆叠占 ~230px、3+1 网格右侧塌空、conic 圆环里塞 12.5px 小数字、左色条+env-chip 双重编码、dashed 虚线过多、详情四块全宽无分组且滚动丢上下文。按 1Panel 的三条纪律重排（**信息密度均匀 / 单一卡片体系 / 颜色只表达语义**，白底语言与双 tab 导航不变）：① hero 与应用中心共用 `PageHero`（标题/副标题/统计 chip 同结构，切换零位移；原 `.mon-hero` 一行化已移除）；② 主机卡列数随台数自适应（`hostCols` computed：2..5 列里选「行数最少 → 末行空位最少 → 卡更宽」，`.host-grid.c1-.c5` 类绑定 + ≤1200/≤820px media 降 3/2 列；4 台=c4，5 台=5 列，6 台=3×2 整行排满，13 台以上仍 5 列封顶）：conic 圆环 → 三列「21px mono 大数字 + 4px 迷你进度条」`.hc-metrics`（≥70 橙 / ≥88 红），负载/网络/运行并为一行弱信息 `.hc-line`，删卡片左色条（env 编码只留 env-chip），卡内虚线全换实线，`@property --v` 随圆环一并删除；③ 详情 sticky 上下文头（`.detail-head` 负 margin 铺满卡片宽、`top: 59px` 贴顶栏下沿，滚动中主机名+时间范围常驻）+ 三组分组标题「资源趋势 / 目录维度 / 进程明细」（`.group-cap` 带拉通 hairline；进程明细的 h4 不再重复标题，只留统计与清除过滤）。glass-v2 **未同步**此重排（毛玻璃端点自身布局另议）。

**实测基线**（2026-11-10）：网关常驻 ~35MB；本机 516 进程全扫 + 50 个归属进程聚合，单 tick <100ms；WS 终端端到端自检通过（`.verify/term-test.mjs`，审计正确记录命令）。

---

## 9. 设置 API（`scripts/settings-server.mjs`）

零依赖 Node HTTP 服务，仅监听 `127.0.0.1:8300`（端口可用 `SETTINGS_PORT` 覆盖），nginx 反代 `/api/`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 返回 `apps.config.json` 内容（含 `$comment`） |
| POST | `/api/config` | 校验 → 原子写入（原文件备份 `.bak`）→ **后台** `probe --no-fetch` → 立即 `{ok:true}` |
| POST | `/api/probe` | 「立刻同步」：后台执行**完整**探测（含 git fetch），立即返回 `{ok:true, startedAt}`；前端据 `startedAt` 轮询 `probedAt` |
| GET | `/api/healthz` | 存活检查 |

**校验规则**（`sanitizeConfig`）：`id` 必填且全局唯一；远程应用 `healthUrl` 必须是合法 http/https URL；`expectedPort` 非法值置 `null`；`tags` 支持数组或逗号分隔字符串；只保留已知字段（白名单）。

**安全边界**：只写配置文件本身，不执行 shell、不读取/不写 `/root/applications`。⚠️ 该写接口对局域网开放（与各应用自身「无登录」同等信任级别）。如需收紧，在 nginx `/api/` location 加 `allow/deny` 或 Basic Auth——注意 `conf.d/default.conf` 与 `nginx.conf` 的 paraportal 块**两处都要改**。

**为什么要异步**：早期版本 POST 同步等探测跑完（含 GitHub fetch）才响应，实测卡 27 秒以上。现在改保存触发 `--no-fetch`（约 0.3 秒），`probedAt` 变化由前端轮询感知。

---

## 10. 部署与 nginx

### 10.1 `deploy.sh` 四步

1. `node scripts/probe-apps.mjs`（**必须在构建前**，见踩坑 #3）
2. `npm run build`
3. `rsync -a --delete dist/ /root/applications/my-homepage/www/`
4. `nginx -t && nginx -s reload`

### 10.2 nginx 配置（两处！）

**A. `/etc/nginx/conf.d/default.conf`** — `listen 80 default_server`，root `/root/applications/my-homepage/www`，含 SPA 回退、`/api/` 反代、`/assets/` 长缓存、`apps.json` no-cache，独立页面 `/glass/`、`/unslop/`、`/monitor/`（`root /root/applications/my-homepage`），以及 `/api/monitor/` 反代与 `/api/terminal` WebSocket 反代（→ 127.0.0.1:8301）。

**B. `/etc/nginx/nginx.conf` 内的 `server { listen 80; server_name 127.0.0.1; }`** — 这是 paraportal 遗留配置块，携带 `/Platform`、`/visualization`、`/pushservice` 等到 `127.0.0.1:8080` 的代理。原始 `root` 指向**不存在的** `/opt/paratera/paraportal/gui/webapps/ROOT`。

已做的最小改动：`root` 改为 `/root/applications/my-homepage/www`，并补上 `/api/` 反代与 `/glass/`、`/unslop/`、`/monitor/` 独立页面 location 及 `/api/monitor/`、`/api/terminal` 反代。**不要删这个块**（会破坏 docker:8080 的代理路径）。

> `/glass/`、`/unslop/`、`/monitor/`、`/api/monitor/`、`/api/terminal` 必须两处都配：`Host: 127.0.0.1` 走 `nginx.conf` 的块，局域网 IP 走 `default.conf`，否则会出现「一个入口能开、另一个 404」。静态页两处都用 `root`（不是 `alias`）+ `try_files $uri $uri/ /<page>/index.html`，`alias` 与 `try_files` 组合会导致静态资源 404。WS location 需要 `proxy_http_version 1.1` + `Upgrade/Connection` 头 + 3600s 读超时。

备份：`/etc/nginx/conf.d/default.conf.bak`、`/etc/nginx/nginx.conf.bak`（另有 `*.bak-glass-20261104`、`*.bak-unslop-20261106`、`*.bak-monitor-20261110`）

### 10.3 systemd

```bash
cp systemd/*.service systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now my-homepage-probe.timer my-homepage-probe-quick.timer my-homepage-settings.service my-homepage-monitor.service
```

服务文件里 `ExecStart` 用的是绝对路径 `/usr/local/bin/node`。

### 10.4 服务生命周期与手动控制

三个脚本都在 `scripts/` 下，需 root，行为严格区分：

| 脚本 | 对 systemd 的作用 | 语义 |
|---|---|---|
| `start.sh` | `enable --now` 四个单元 + 跑一次 `probe --no-fetch` | 恢复开机自启并立即运行 |
| `restart.sh` | `restart` 四个单元 + 跑一次 `probe --no-fetch` | 重启，**不改自启状态**；若当前 disabled 会警告"重启后不会自启" |
| `stop.sh` | `disable --now` 四个单元 + 停掉可能在跑的 probe oneshot | **永久关闭**：重启服务器也不自启 |

关键事实：

- **主页是静态文件**，由共享 nginx（80 端口）托管，且同一 nginx 还承载 `/Platform` 等历史代理，因此 `stop.sh` **不动 nginx**。停止后页面仍能打开，但 `apps.json` 不再更新、设置面板保存失败（`/api/config` 返回 **502**）、监控 API 返回 502、终端不可用。
- 当前五个服务（`my-homepage-settings`、`my-homepage-probe.timer`、`my-homepage-probe-quick.timer`、`my-homepage-monitor`、`nginx`）均为 `enabled`，开机自启已生效。核对：`systemctl is-enabled <unit>`。
- 设置服务停机时 `/api/config` 应返回 **502**。早期曾返回 404，原因是 `nginx.conf` 的 paraportal 块里 `error_page ... /50x.html` 配了 `root html;`（解析为不存在的 `/etc/nginx/html/50x.html`），错误页取不到导致状态码被降级；已改为 `root /usr/share/nginx/html;`。

---

## 11. 踩坑记录（血泪，务必保留）

1. **`/proc/<pid>/cwd` 必须用 `readlinkSync`**
   它是 magic symlink，`readFileSync` 会跟随它去读目录内容而报 EISDIR，导致全部应用匹配失败、退回 TCP 探测并丢失「是否对外监听」信息。（现象：所有应用都被标「仅本机」）

2. **`Host: 127.0.0.1` 会命中 `nginx.conf` 的 paraportal 块**
   本机 `curl http://127.0.0.1/` 与浏览器访问 `127.0.0.1` 都走那个 server block，只改 `conf.d/default.conf` 会出现「局域网 IP 能开、127.0.0.1 返回 404」。两处都要维护。

3. **`deploy.sh` 探测与构建的顺序不能反**
   曾出现「先 build 后 probe，rsync 把构建时打进 dist 的**旧 apps.json** 覆盖回线上」，导致已删除的测试条目重新出现。顺序固定为 **probe → build → rsync**。

4. **主端口不能简单取最小值**
   `network-monitor` 目录下曾有 `sshmockd` 监听 `127.0.0.1:2222`（非 HTTP），取最小端口会把主页链接指到死地址。已改为 `expectedPort` 锚定优先（§7.1.4）。

5. **设置保存同步等探测 → 卡 27 秒**
   已改异步 + `--no-fetch`（§9）。

6. **`defineProps` 在同一 SFC 中只能调用一次**
   编辑 `AppCard.vue` 时插入新 `const props = defineProps(...)` 而没删旧的，构建直接报 `duplicate defineProps() call`。

7. **视觉验证要用专用 headless shell**
   本机 Chrome 153 常规 `--headless --screenshot` 会挂住。可用做法：

   ```bash
   # 复用 ZCode 运行时自带的 playwright-core + 缓存里的 headless shell
   node -e "
   const { chromium } = require('/root/.zcode/server/releases/3.17.1-linux-x64-ec11bd918516/runtime/node_modules/playwright-core')
   ;(async () => {
     const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] })
     const p = await b.newPage({ viewport: { width: 1500, height: 1000 } })
     await p.goto('http://127.0.0.1/', { waitUntil: 'networkidle' })
     await p.screenshot({ path: '/root/applications/my-homepage/.verify/shot.png' })
     await b.close()
   })()"
   ```
   `.verify/` 下的 `shot.cjs`、`shot2.cjs` 是可直接参考的完整脚本。

8. **`apps.config.json` 被设置面板重写会丢格式**
   面板保存走 `sanitizeConfig` 白名单 + `JSON.stringify(indent: 2)`，会**重排字段顺序、丢弃未知字段**（`$comment` 例外，被单独保留）。手工加的注释放 `$comment` 里或加在已知字段上。

9. **`--no-fetch` 时 `remoteOk` 为 `null`**
   前端据此不显示「远端不可达」警告，沿用上次远端快照。别把它当成 fetch 失败。

10. **`hidden` 属性会被组件的 `display` 规则顶掉**
   给带 `display: inline-flex` 的元素加 `hidden` 不会隐藏它（作者样式 > UA 样式的 `[hidden]{display:none}`）。`unslop/assets/app.css` 顶部用 `[hidden]{display:none!important}` 兜底；Vue 组件里则用 `v-if` 或显式 class 切换。

11. **原生 HTML 不支持自闭合 `<div />`**
   从 Vue 模板搬静态 HTML 时，`<div class="skeleton-row" />` 在浏览器解析里是**未闭合的开始标签**，会把后续兄弟内容全部吞为其子元素——曾把 footer 吞进 `#u-content`，首次 `innerHTML` 渲染将其销毁、`renderPageText` 因找不到 `#u-copy` 抛错、整个页面渲染中断。静态 HTML 里必须写全 `</div>`。

12. **元素重置选择器别带类型名，会压过单类组件样式**
   `glass.css` 的 `.fg-body button { border:0; background:none }`（0-1-1）曾压过 `.fg-iconbtn`/`.fg-syncbtn`/`.fg-minibtn`/`.fg-retry`（0-1-0），导致这些按钮的玻璃底整体失效、仅悬停闪现；分段控件幸存只因选择器恰好同为 0-1-1 且在源码顺序之后。重置只放 font/color/cursor 等无冲突属性，边框底色交给组件类自己定义；组件类若需要压过重置，就写完整选择器或提高特异性。（与踩坑 #10 同族：`hidden` 也是被更强的 display 声明顶掉）

13. **`String.raw` 模板不转义 `${`**
   `monitor-server.mjs` 的远程探测 shell 片段写在 `String.raw` 里，`${d##*/}` 仍被 JS 解析成模板插值 → `SyntaxError: Missing } in template expression`。`String.raw` 只禁用转义处理、**不禁用插值**；含 `${` 的段落要用普通模板串写 `\${`，或如本项目拆成 awk 段（String.raw）+ shell 段（普通模板）两段拼接。

14. **`pkill -f <脚本名>` 会自杀**
   在 bash 工具里跑 `pkill -f 'monitor-server.mjs'` 时，**当前 shell 的命令行本身**就包含该字符串，pkill 把执行命令的 shell 一起杀了，表现为「命令无输出」。按 PID kill（`kill $(cat pidfile)`）或用不会自匹配的模式。

15. **Playwright `networkidle` 与前端轮询互斥**
   监控看板每 5s 轮询 summary，`waitUntil: 'networkidle'` 永远等不到静默窗口而超时。轮询型页面用 `waitUntil: 'domcontentloaded'` + 显式 `waitForSelector`。主页/静态演示页无轮询才可用 networkidle。

16. **系统 `ssh` 免密 ≠ ssh2 单钥匙免密**
   排查终端「All configured authentication methods failed」时发现：CLI `ssh root@127.0.0.1` 会**依次尝试所有默认身份**（id_ed25519 → id_rsa），实际免密的是 `id_rsa`（id_ed25519 不在 authorized_keys）；而 ssh2 只用配置里指定的一把钥匙。给网关配 `keyPath` 前先 `grep "$(ssh-keygen -y -f <key>)" ~/.ssh/authorized_keys` 确认该公钥确实在列。

17. **`<KeepAlive>` 放在 `v-if/v-else` 分支里 = 没有缓存**
   监控视图首版用 `<template v-if>…</template><KeepAlive v-else><MonitorView/></KeepAlive>` 做视图切换，结果每次切回都重新 mounted（deactivated 触发了、但分支卸载时 KeepAlive 自身连同缓存一起被销毁）。视图切换要保状态：要么双方都 `v-show` 常驻（本页采用：`MonitorView` 接 `active` prop 自管轮询与首次 boot），要么 KeepAlive 常驻包 `<component :is>`。

18. **临时替换鉴权材料必须有「先验证还原」的闭环**
   联调监控登录时曾把 `monitor.config.json` 的 passwordHash 换成测试哈希，备份后又在验证还原**之前**就执行了 `rm` 备份文件（且本机 `cp` 带 `-i` 别名，非交互 shell 下覆盖被拒）——用户自设密码哈希丢失，只能临时密码过渡请用户重设。教训：动鉴权/凭据类文件，备份后**立即验证还原路径可用**，验证通过前不许清理；非交互 shell 用 `command -p cp -f` 绕过别名。

19. **`@property` 注册自定义属性必须 `inherits: true` 才能被伪元素继承**
   监控主机卡圆环 `conic-gradient(color calc(var(--v)*1%), …)` 画在 `.gauge::before` 上，`--v` 注册成 `inherits: false` → 伪元素看到的 `--v` 恒为 initial 0 → 整环只剩底轨（用户报「圆环没显示」）。`inherits: true` 后伪元素继承父元素上（含 Vue :style 绑定/过渡中的）值即恢复正常。取证方法：`getComputedStyle(el,'::before').backgroundImage` 直接看伪元素解析出的渐变。

20. **echarts.init 的容器可能被 v-if 摘掉**
   详情页图表容器加了 `v-if="dirsList.length"`（无目录收起）后，`echarts.init(elDirs.value)` 在 null 上崩（`getAttribute of null`）。凡是「存在性随数据变化」的容器，init/setOption 前必须判空返回；或改 v-show（注意 0 尺寸需 resize，见本文件既有处理）。

21. **CLI 子命令与常驻服务写同一份文件时，常驻侧必须热加载**
   `--agent-install-cmd` 在独立 node 进程生成 agent token 写 `credentials.json`，常驻网关内存里的 credentials 还是旧的 → push 校验 403。已对 credentials.json 加 fs.watch 防抖热加载（与 monitor.config.json 同款）。教训：任何「CLI 写、服务读」的文件都要么服务端 watch，要么收敛为单点写入。

22. **归属/聚合逻辑不得依赖「只有一条采集路径才预计算」的字段**
   目录归属最初只在本机采集时预计算 `p._dir`，`buildSnapshot` 直接消费 → 远程进程（无 `_dir`）全部漏归属，远程目录恒空。修复：buildSnapshot 内对无 `_dir` 的进程现场 `matchDirOf(cwd/exe/cmdline)`。多条采集路径共享一个加工函数时，加工函数不能假设某条路径已做过的预处理。

23. **监控 UI 的 Playwright 验证不用登录：从 sessions.json 注入会话 cookie**
   全站门禁下 Playwright 新开浏览器会撞登录层。正确做法（**只读**，符合 #18 教训——绝不动鉴权材料）：读 `data/monitor/sessions.json`，取一个 `expires > now` 的 token，`context.addCookies([{ name: 'mh_mon', value: token, url: 'http://127.0.0.1' }])`。轮询页照例用 `domcontentloaded` + `waitForSelector`（见 #15）。现成脚本：`.verify/shot-hostedit.cjs`（主机设置弹窗三态）、`.verify/shot-cmpall.cjs`(目录对比默认全选/自刷/全选清空)。

24. **配置「校验报错」类测试必须挑 SSH 主机，别用本机主机**
   本机（type=local）的展示地址留空时 `normalizeHost` 会默认填 `127.0.0.1`——清空地址点「保存」不会触发 400，反而**把展示地址真实改掉**（实测把 `10.8.11.4` 改成了 `127.0.0.1`，靠同一条 PUT API 改回）。SSH 主机才有「缺 address → 400 `主机 xx 缺少 address`」的校验路径，且失败不落盘。


25. **`saveConfig()` 会重建 config.hosts，跨保存持有主机对象 = 写丢**
   `saveConfig` 末尾执行 `config = loadConfigSync()`，之前捕获的 `host` 引用即成为游离对象；`host.keyPath = …` / `host.mode = 'agent'` 写到它身上不会落盘（实测 netwatch 纳管后 keyPath 为空、mode 仍 ssh，导致终端「未配置私钥」+ SSH 采集失败覆盖 agent 推送）。修复：统一走 `upsert(mut)` —— 每次重新 `find` 当前主机 → 改 → 立刻保存，从不跨保存持有引用。

26. **ssh2 连接用完必须 end()，否则 keepalive 长期挂 ESTABLISHED**
   provision 的「免密验证」连接当时只 await 没关闭，`keepaliveInterval: 15s` 让它一直存活——`ss` 里能看到网关到目标的常连，违背「agent 模式零 SSH 连接」的设计承诺。凡 `connectSSH()` 得到连接，业务结束必须 `conn.end()`（探测/终端路径已有 finally，新增路径容易漏）。

27. **登录限速必须只计失败，别计入成功登录**
   原 `rateLimited()` 在每次 login 请求都自增，5 次/分连**正确密码**也会被 429（连续跑 E2E 时必现）。改为 `rateLimited()` 只读判定 + 新增 `recordAuthFail()` 仅在密码错误时计数（实测：连续 7 次正确密码全 200；连续错误密码 5×401 后 429）。

28. **原生 DOM 写内容后立刻重渲染 = 内容被冲掉**
   设置面板把 provision 步骤写进 `<ol>` 后马上调 `renderSettings()`（模板字符串全量重建），刚写的日志被清空、只剩占位「正在连接…」。正确做法：状态驱动——步骤存 `host._provSteps`，模板负责渲染，任何时候重渲染都能保真。

29. **变量定义在嵌套闭包里，外层分支直接引用 = 运行时 ReferenceError（`node --check` 不报）**
   `connectSSH` 的密码分支引用了 `opt.hostVerifier` 闭包内声明的 `rec`，密码认证走「加密存档」路径时直接抛 `rec is not defined`。一直没暴露是因为 provision 传入一次性 `_password` 短路了该表达式（2026-11-11 系统测试修复：`rec` 移入分支内定义）。教训：**每条凭据路径（key / 一次性密码 / 加密存档密码）都要有一条真实 E2E**，只测过主路径的分支等于没测。

30. **解析外部命令输出前，先对照真实表头数一遍列**
   远程采集 `df -kPT` 数据行是 **7 列**（Filesystem Type 块 已用 可用 **配额** 挂载点），原代码 `mnt: f.slice(5)` 把配额列混进了挂载点——三台远程主机全部呈现 `mnt: "22% /"`，且告警 key `disk:<mnt>` 随使用率变化漂移（持续计时被重置）。修复为 `f.slice(6)`（2026-11-11）。同类风险：`String.raw`/awk 段、`/proc` 行格式改动时，先在目标机跑一遍真实输出再写解析。

31. **多会话并行改同一仓库：`git add -A` 会把别人未提交的工作扫进你的提交**
   优化轮期间检测到另一会话正在做终端加固（MonitorTerm/MonitorView/MonitorBatchTerm/terminal.js/glass-v2）：其 MonitorTerm 改动在 07:06 落盘、被 07:07 的 `git add -A` 收进我的提交，而 MonitorView 的对应改动 07:10 才落盘——一度两边都不调 window.open（子端删了、父端注释说「由子端负责」），「弹出」按钮谁都打不开。教训：提交前逐文件核对 `git status`/`git diff`，发现非本会话改动先确认归属与意图，再决定收编或避开；跨会话的职责约定必须落到同一处（本例收敛为「子端 emit、父级统一 window.open」）。另外并行会话与我在服务端 idleTs 上各自实现了同一修复，后写者 Edit 工具会报「modified since read」——这是发现并行编辑的信号，应停下重读而不是重试覆盖。

32. **修竞态时误删「正常路径」代码，且回归没跑到就提交 = 产品 bug 直接入库**
   glass-v2 `openBatch()` 修 60ms 关闭竞态（加 `if (!bt.open) return` 守卫）时，把紧随其后的 `for (hosts) connectPane(h)` 连接循环一并删掉——批量终端窗格永久停在「连接中…」，且该 bug 随 e4a14a0 提交（当时终轮回归该套件恰好没跑），两天后终验回归才暴露（2026-11-11 修复，commit 3155662）。教训：① 任何「在函数末尾加守卫」的改动，diff 必须逐行看——守卫与后续逻辑在同一异步流里，删循环等于阉割主功能；② 竞态类修复**必须当场重跑覆盖该路径的 E2E 再提交**，「上次跑过」不算数；③ E2E 断言要打在结果上（`.xterm-rows` 出现 = 真连上了），本案正是靠结果断言而非 DOM 存在性才暴露。

33. **UI 重构改根类名/入口位置后，E2E 选择器要同轮更新**
   da1db75 把监控设置弹窗对齐应用中心设计体系（根类 `.mon-modal` → `.settings-panel.mon`、入口从工具栏按钮移到顶栏常驻齿轮），但 e2e-spa / e2e-provision 仍按旧选择器找——表现为「设置弹窗打开」断言失败、后续点击被 `.settings-overlay` 拦截超时（2026-11-11 已同步更新，.verify 不入库故此记录留档）。教训：改组件根类名/挂载点时 grep 一遍 `.verify/` 下的测试脚本同步更新。

---

## 12. 设计决策史（为什么是现在这样）

| 决策 | 原因 |
|---|---|
| 数据用运行时 `apps.json` 而非打包进 JS | 探测器可直接更新线上文件，**纯数据改动无需重新构建** |
| 端口靠 `/proc` 归属判定而非配置文件 | 用户最初给的是 README 里的端口（云监控 8126），实际已在 18001；实测才可信 |
| 支持自动发现未登记应用 | 用户会持续把项目迁入 `/root/applications`，漏登记也不该消失 |
| git 同步检测（fetch + status + ahead/behind） | 用户要求「检测源码是否完全同步至 git」，首测即发现 study-log 24 处未提交、expense-assistant 无仓库 |
| `exclude` → 后来改 `type: "app"` | 用户后来明确「无 Web 服务的（APP/小程序）不要隐藏，显示灰色离线APP」 |
| `type: "app"` → `kinds` + 三状态 | 用户要求分类 Web/APP/小程序可多选；纯 APP 不探测显示灰色「离线应用」，APP+Web 探测 Web；状态改为运行中绿 / 未运行红 / 离线应用灰 |
| 远程应用独立 `remoteApps` 段 | 公网应用无本地目录，探端口/查 git 都不适用，改走健康接口 |
| 设置面板 + 本机 API 服务 | 用户要求「在首页设置页修改，不进配置文件」。静态站点无法写文件，故加回环 API |
| 设置面板列表化 + 弹窗编辑（2026-11-07） | 用户要求「点击应用弹窗设置，节省空间」：应用区块从全字段 fieldset 改为紧凑列表，编辑字段整体移入嵌套弹窗；草稿仍由底部「保存」统一提交，保存语义未变 |
| 保存异步 + `--no-fetch` | 同步等待 GitHub fetch 导致保存卡 27 秒 |
| fetch 串行 → 并发 6 + 连接复用 | 实测 10 仓串行约 37 秒，并发后完整探测约 6 秒；加锁避免与 3 分钟快速探测同时写 `apps.json` |
| 拖拽仅手柄触发 | 用户反馈点击卡片会触发拖拽 |
| 内网蓝 / 公网橙 | 用户要求「内网和公网区分明显，可用颜色」 |
| 3 行简介 + 固定行高 | 用户要求「简介过长换行、每行高度一致」；超 3 行截断（悬停看全文）是行高一致的必要代价 |
| `/unslop/` 设计对比端点（2026-11-06） | 用户要求「unslop 主页，生成新端点、保留旧的对比」；按 glass/ 先例做独立静态页，零构建、零风险，旧主页一字未动。首版「机房仪表盘」方向被用户否掉（「还没有原来的好看」），v2 改为主站视觉 1:1 移植 + 仅 4 处净化修正 |
| Agent 推送采集模式（2026-11-10） | 用户要求「免 SSH 常连监控，agent 定时上报，一键安装」；目标机零依赖 sh agent 与 SSH 采集同源（口径一致），监控零 SSH 连接（终端仍 SSH）；**阿里云公网不可内连中心 → 保留 SSH 拉取为定制方案**（agent 开关留好） |
| 每主机跟踪目录（2026-11-10） | 用户要求「非本服务器也能选应用目录做目录监控」——`hosts[].trackedDirs[]`，归属集按主机合并；远程补 cmdline 采集，修复 buildSnapshot 只认本机预计算字段的漏归属 |
| 登录层升级为全站门禁（2026-11-10） | 用户要求「登录层覆盖整个系统」：未鉴权登录层盖住应用+监控两视图（App.vue 持有状态，MonitorView unauth 事件上抛）；网关宕机 fail-open 不锁主页 |
| 详情页删分区用量 + 布局/按钮重做（2026-11-10） | 用户反馈「圆环没显示（@property inherits 根因）、按钮丑、布局不合理」：目录占比全宽、无目录主机收起空盒、按钮统一软胶囊两档、时间窗分段控件、去 emoji |
| 监控设置主机改紧凑列表+弹窗编辑（2026-11-10） | 沿用应用设置面板的紧凑列表交互：主机行点击弹 `MonitorHostEdit` 嵌套弹窗（草稿/直连双模式），节省空间 |
| 监控选自研网关而非 Prometheus/Grafana/Netdata（2026-11-10） | 核心诉求「按目录归属进程资源」在成熟方案里均按 cmdline 模板分组、不支持 cwd 维度；且现有系统是零依赖/systemd/回环反代哲学，专业栈体量失衡。预留 `/metrics` 与 webhook 兜底专业栈价值 |
| Web SSH 选 xterm.js + ssh2 自建网关（2026-11-10） | 需求要求会话鉴权/凭据加密/访问审计/超时——ttyd/Wetty 的 pty 直通架构四项全空白；GateOne 已停维护否决；与监控共用同一网关与鉴权体系 |
| 目录跟踪默认复用主页 `apps[].directory` | 用户已在主页登记应用目录，监控侧零重复配置；自定义目录走 `trackedDirs[]`（界面/文件/API 三通道） |
| 远程采集免 Agent（ssh2 exec 注入脚本） | 目标机（NetWatch/阿里云）不想装常驻组件；探测脚本纯只读、计数器口径由网关差分，单次 <1.5s；Agent 推送模式留作扩展 |
| 监控/终端独立访问密码而非复用主页 | 主页本无登录体系；监控持有服务器凭据必须独立鉴权，OIDC 统一登录留作扩展点 |
| 白底视觉 + 同源变量（2026-11-10） | 用户明确要求监控看板「以白色底色为主、保持现有风格一致、适度炫酷」：全套复用 src/style.css 变量，动效只走合成层并 reduced-motion 降级 |
| 监控主机设置弹窗化 + 详情页 ⚙（2026-11-10） | 用户要求「点击服务器弹窗设置、详情页加齿轮直达」：复用主页设置面板 2026-11-07「紧凑列表 + 嵌套弹窗」成熟模式，抽出 MonitorHostEdit 共享组件；详情页齿轮走直连保存（就地调单机不必开整个设置面板） |
| 目录历史对比默认全选（2026-11-10） | 用户要求「默认全选」：seededDirs 只补新目录，15s 自刷不勾回手动取消项；另配全选/清空按钮兜底 |
| 监控布局对照 1Panel 重排（2026-11-10） | 用户反馈「1Panel 布局好看、我们的有点奇怪」：根源是 hero 三层堆叠 / 圆环数字小 / 装饰编码重复 / 详情无分组。按「密度均匀、单一卡片体系、颜色只表达语义」收紧，白底语言与导航不变（详情见 §8.7 布局重排段） |
| 应用中心 ⇄ 监控中心双向同步（2026-11-11） | 用户要求「添加应用可选同步到监控中心并监测，反之亦然，中断自动重试」：选 fs.watch 文件级同步（monitor-server 只写 monitor.config、settings-server 只写 apps.config，单一写者）而非前端编排——UI 之外（CLI/手工改配置）同样生效；「无 diff 不写盘」防回环，重试器退避抗读写竞态（详见 §17） |

---

## 13. 当前应用清单（2026-11-10 探测）

| id | 名称 | 归属 | 端口/地址 | git |
|---|---|---|---|---|
| cloud-monitor | 云计算监控大屏 | 本机 | 18001 | synced |
| storage-monitor | 存储集群监控大屏 | 本机 | 18002 | synced |
| study-log | StudyLog 成绩记录 | 本机 | 3000 | synced（曾 dirty） |
| tv-show | 数智中心大屏聚合平台 | 本机 | 18000 | **dirty** |
| expense-assistant | 财务报销附件助手 | 本机 | 19000 | synced（**曾无仓库**，后补建） |
| wedding-plan | 备婚计划 | 本机 | 19002 | synced |
| jianji-ledger | 简记 · 账本 | 本机（离线应用，kinds: app） | — | no-repo |
| time-logger | 时间记录器 | 本机（Web + APP） | 19001（https） | synced |
| my-homepage | 我的应用导航（本站） | 本机（nginx 托管） | 80（+8301 监控网关，仅本机） | 已纳入 git |
| network-monitor | NetWatch 网络监控 | **外机**（10.8.14.200） | http://10.8.14.200 · v1.0.2 | — |
| log-gpt-agent | 网络安全自动运维平台 | **外机**（10.8.11.3） | http://10.8.11.3/ · 页面 200 | — |
| study-log-cloud | StudyLog 公网版 | **公网**（阿里云） | http://47.95.140.199:3000 · v1.2.0 | — |

> 状态会随时变化，以上仅为撰写时快照。以 `curl -s http://127.0.0.1/apps.json` 为准。

**监控中心纳管主机清单（2026-11-10 上线）**：

| id | 名称 | 地址 | 采集方式 | 跟踪目录 | 状态 |
|---|---|---|---|---|---|
| local | 本机 · 应用宿主 | 10.8.11.4 | 直读 /proc | 10（主页登记自动并入） | ONLINE |
| netwatch | NetWatch 服务器 · centerserver | 10.8.14.200 | **agent 推送** | /root/network-monitor | ONLINE |
| aliyun | 阿里云 · StudyLog 公网版 | 47.95.140.199 | SSH 拉取（公网机定制） | studylog + 顺丰账本×2 | ONLINE |
| lan-1103 | 内网节点 · 113 | 10.8.11.3 | SSH 拉取 | /root/log_gpt_agent | ONLINE |

**已知的应用侧问题**（不是主页的 bug，修应用即可，主页无需改动）：expense-assistant 根路径 500（`/docs` 正常）、wedding-plan 根路径 404（`/health` 正常）、network-monitor 根路径 404（其 UI 在 :8080）。

---

## 14. 常见任务配方

**新增一个本机 Web 应用**
1. 应用放入 `/root/applications/<id>` 并启动（有监听端口）；
2. 首页 ⚙ 设置 → 本机应用「＋添加」→ 填 id（=目录名）、名称、目录、期望端口 → 保存；或直接编辑 `apps.config.json` 后 `npm run probe`；
3. 前端 60 秒内自动出现。（漏登记也会被自动发现，标「待补充」）

**新增一个离线应用（纯 APP / 小程序）**
同上，但应用形式只勾选 APP / 小程序 / 电视 / CLI 中适用的项、不勾 Web（配置里写 `"kinds": ["app"]`），不需要期望端口；只要勾了 Web 就会照常探测。

**新增一个外机 / 公网应用**
设置面板 → 「外机应用」或「公网应用」区块「＋添加」→ 填 `healthUrl`（必填）、访问 URL、位置、主机，以及技术栈（主要语言 / 前端 / 后端，远程应用不会自动识别）；`env` 决定归属（`lan`=外机 / `public`=公网）。或编辑 `remoteApps` 后 `npm run probe`。外机应用示例：`network-monitor`（10.8.14.200）、`log-gpt-agent`（10.8.11.3，健康接口用站点根路径，返回 HTML 也算在线）。

**改页面文案 / 顶栏名称** → 设置面板「页面信息」→ 保存（改 `page` 段，无需重新构建）。

**调整默认显示顺序（对所有访客生效）** → 在 `apps.config.json` 顶层加 `"order": ["id1","id2",…]` → `npm run probe`。注意浏览器手动排序优先于此。

**迁移项目目录**（换了源目录后，systemd 的 `ExecStart` 仍指向旧路径，必须同步改）

```bash
./scripts/move-project.sh <目标目录> --dry-run                        # 先看计划
./scripts/move-project.sh <目标目录>                                  # 只搬项目，部署目录保持
./scripts/move-project.sh <目标目录> --webroot <新的部署目录>           # 连部署目录一起搬
```

脚本会自动：暂停并恢复服务 → `mv` 项目 → 改 `systemd/*.service` 的 `ExecStart` 并重装 →（可选）迁移 webroot 并同步 `deploy.sh` / `probe-apps.mjs` / 两处 nginx `root` → 更新本文档与 README 中的路径 → 跑一次探测 → 校验主页与 `/api/config` 均 200。**幂等**，要搬回去就用原路径再跑一次。

> 当前部署目录由脚本从 `deploy.sh` 的 `WEBROOT=` 自动读取，不写死。
> 只有 3 处绝对路径硬编码：三个 systemd 单元（probe / probe-quick / settings）的 `ExecStart`、`probe-apps.mjs` 里的 webroot。其余代码全部基于 `__dirname` 相对定位，因此单纯 `mv` 后不重装单元会导致定时探测与设置服务失效。

**迁移史**：
- 2026-11-03 ① 从 `/root/gjx-homepage` + `/var/www/gjx-homepage` 迁至 `/root/applications/gjx-homepage` + `…/www`；
- 2026-11-03 ② 项目目录改名为 `/root/applications/my-homepage`（webroot 随之为 `…/my-homepage/www`），本站应用条目的 `id`/`directory` 同步改为 `my-homepage`；
- 2026-11-03 ③ systemd 单元改名为 `my-homepage-settings.service` / `my-homepage-probe.{service,timer}`（旧 `gjx-homepage-*` 单元已停用并删除），前端 localStorage 键改为 `my-homepage:appOrder`（**改键会重置浏览器里已保存的手动排序**，需重新拖拽一次）。

> 旧路径 `/root/gjx-homepage` 是指向新目录的软链接，由使用者手动删除。

**新增一台被监控服务器**（两种路径）
- **内网机（推荐 Agent 推送）**：主页 ⚙ 监控设置 → 纳管主机「＋添加主机」→ 填 id/名称/地址/密钥 → 该主机弹窗「采集方式=Agent 推送」→ 点「生成安装命令」→ 复制到目标机 root 执行（幂等，只新增文件与服务）→ ≤70s 上线；SSH 密钥仅终端需要（可选）。CLI：`node scripts/monitor-server.mjs --agent-install-cmd <hostId>`
- **公网机（SSH 拉取）**：加主机（mode 默认 ssh）→ `ssh-copy-id -i data/monitor/keys/<id>.pub root@<host>` 分发监控密钥 → ≤20s 上线
- 两模式随时互切（设置里改「采集方式」保存即热加载）

**为远程主机配置目录级监控** → ⚙ 监控设置 → 点该主机行 → 「该主机跟踪目录」＋添加目录（该机上的绝对路径）→ 保存热加载 → ≤20s 出「应用 / 目录资源占比」柱图与进程明细；归属靠该机进程 cwd+命令行

**排查「页面没更新」**
```bash
curl -s http://127.0.0.1/apps.json | head -5          # probedAt 是否在刷新
systemctl status my-homepage-probe.timer my-homepage-probe-quick.timer
journalctl -u my-homepage-probe.service -n 30 --no-pager
journalctl -u my-homepage-probe-quick.service -n 30 --no-pager
stat -c '%y %n' /root/applications/my-homepage/www/apps.json public/apps.json   # 两份应为同一时间
```

**排查「设置保存失败」**
```bash
systemctl status my-homepage-settings
journalctl -u my-homepage-settings -n 30 --no-pager
curl -s http://127.0.0.1/api/config | head -5      # 直连服务
curl -s http://127.0.0.1/api/config | head -5      # 经 nginx（两处都要通）
```

**监控/终端相关**
```bash
# 纳管一台远程主机（人工输一次目标机密码分发公钥，之后 ≤20s 自动上线）
ssh-copy-id -i data/monitor/keys/<hostId>.pub root@<目标IP>
# 忘记监控密码
echo '新密码' | node scripts/monitor-server.mjs --set-password-stdin
# 看会话审计 / 告警历史
tail -5 data/monitor/audit.jsonl
tail -5 data/monitor/alerts.jsonl
# 终端端到端自检（需要已登录会话；脚本自动登录）
node .verify/term-test.mjs
# 监控 UI 免登录验证（Playwright；见踩坑 #19 的会话注入法）
node .verify/shot-hostedit.cjs   # 主机设置弹窗（草稿/直连/校验错误路径）
node .verify/shot-cmpall.cjs     # 目录对比默认全选 + 自刷不勾回 + 全选/清空
# 排障速查表见 docs/monitor-ops.md §6
```

---

## 15. 禁止事项 / 注意事项

- ❌ **不要删除 `nginx.conf` 里的 paraportal `server` 块**——它承载 `/Platform` 等到 docker:8080 的代理。
- ❌ **不要把 `deploy.sh` 改成先构建后探测**。
- ❌ **不要给整行/整卡加 `draggable`**——只能是拖拽手柄。
- ❌ **不要在探测中执行 `git pull / checkout / reset / gc / push`**——只允许只读命令与 `fetch`；公网服务器是线上机，只允许 pull，探测对任何机器都绝不 push。
- ❌ **agent 相关**：agent token 存 `credentials.json`（gitignored），勿入库勿外传；目标机 `my-homepage-agent.service` 只做采集推送，**不要往里面加写操作**；agent 模式主机的采集由推送驱动，勿再手工起 SSH 定时器（双路会打架）；公网机（无法内连中心）保持 SSH 拉取模式。
- ❌ **不要用 `readFileSync` 读 `/proc/<pid>/cwd`**。
- ❌ **不要把监控网关 8301 改绑 0.0.0.0 / 不经会话鉴权暴露监控 API**——凭据与终端入口都在里面；公网暴露前必须上 TLS。
- ❌ **不要把 `data/monitor/` 下任何内容（凭据/密钥/`.secret`/初始密码/审计）提交进 git**——`data/` 已整体 gitignore，保持。
- ❌ **不要在网关日志/审计之外另存明文密码**——密码只存 scrypt 哈希与 AES-GCM 密文。
- ⚠️ `apps.config.json` 的 `id` 必须与目录名一致，否则端口归属匹配不到（会退回 TCP 兜底，丢失附加端口信息）。
- ⚠️ 改动前端后必须 `./deploy.sh`；只改配置/数据则 `npm run probe` 即可；改 `monitor-server.mjs` 后 `systemctl restart my-homepage-monitor`（改 `monitor.config.json` 不用，热加载）。
- ⚠️ 本项目已纳入 git（origin `github.com:guojiaxian/my-homepage`），改完请 commit/push，保持主页「同步」列干净。
- ⚠️ 本机 nginx 80 端口还承载其他历史代理路径，改 nginx 前务必 `nginx -t` 并保留 `.bak` 备份；`/monitor/`、`/api/monitor/`、`/api/terminal` 与其他独立页面一样**两处 server 块都要配**。

---

## 16. 2026-11-10 会话增量（UI / 图表 / 目录设置）

> 本节记录本轮用户反馈驱动的改动与决策，作为后续接手者的「最近上下文」。更细的实现说明见 §8。

### 16.1 用户明确偏好（按原话）

- **不要 85% 参考线**：趋势图不再画 `markLine` 阈值虚线（阈值仍用于告警/设置）。
- **纵轴要自适应且有单位**：`scale:true`，不再固定 0–100；网络/磁盘轴名标 `Mbps` / `MB/s`，百分比轴刻度带 `%`。
- **不要负载、Swap**：CPU 图只保留 CPU%，内存图只保留内存%，删除左右双轴与两条辅助曲线。
- **要解释颜色/轴**：每图显示图例；图例名带单位；CPU 图头显示「当前 X% · 峰值 Y%」；tooltip 数值带单位；资源趋势标题旁注明「曲线颜色见各图图例 · 纵轴按所选时段的峰值自适应」。
- **主机副标题格式**：`N核 CPU型号 · 内存GB · 磁盘TB/GB · 操作系统`（本机 `32核 Hygon C86 7390 · 32GB · 0.9TB · Kylin V10`）。CPU 型号必须用采集体里的**真实完整型号**（含 Hygon/Intel 厂商前缀，不能只留数字）；内存按**标称容量**显示（`MemTotal` 会少 1–2GB，32GB 机器不能显示成 30GB）。
- **表头排序时列位置不能动**：排序箭头固定占位 11px（`.sort-arrow`），实测切换列 0 位移。
- **黑色方格要删**：目录占比图容器项的 `⬛` 后缀已移除（容器仍显示为「容器 xxx」）。
- **选择控件要好看**：目录指标下拉改胶囊 + 自绘箭头；目录 chip 复选框改 13px 自绘方框。
- **本机跟踪目录不能空**：设置页要显示自动并入的主页登记目录；全局「跟踪目录」区与每主机目录不是一回事，空时不再显示以免误认为重复。
- **顶栏/页头一致**：两视图共用 `PageHero`；齿轮常驻并按视图打开对应设置；tab 字重固定；`scrollbar-gutter: stable` 防横向抖动。

### 16.2 实现要点 / 踩坑补充

- **ECharts 单系列图例**：图例直接显示 `CPU %` / `内存 %`；多系列网络/磁盘显示读写方向与单位；`legend` 不可再 `show:false`。
- **自适应轴的代价**：CPU 轴会随窗口内峰值变化（NetWatch 因 20:50 真实峰值 27.4% 显示 0–30%，当前 3.5% 与目标机 `top` 3.2% 一致）。图头「当前/峰值」是消除「数据不对」误解的关键。
- **进程表排序**：`PROC_COLS` 统一生成 11 个 th；数字列默认降序、文本列升序，再点切方向；空值始终排最后；默认 CPU% 降序。箭头必须始终占位，否则切换列时表头宽度变化。
- **effectiveDirs（跟踪目录）**：`GET /api/monitor/config` 为每台主机附加只读 `effectiveDirs`（全局 + 本机主页登记 + 主机自有 + 运行时自动发现的容器目录）；`PUT` 时 `normalizeHost` 白名单会丢弃它，不会写回配置。主机弹窗「自动并入」目录只读展示（主页登记 / 全局 / 自动发现 chip），自有目录可增删；添加已并入路径会拦截。全局 `cfg.trackedDirs` 区仅非空时显示，标题「全局自定义目录（对所有主机生效）」。
- **容器目录也要显示**：`open-webui` 这类 cgroup 自动发现的容器目录不是手工跟踪项，但设置页必须可见——服务端从 `lastSnap.dirs` 取 `source:'container'` 追加到 `effectiveDirs`，主机行摘要也随之显示 10 个（9 主页登记 + 1 容器），与卡片/图表一致。
- **主机卡等高的实现**：`.host-card` 改 `display:flex; flex-direction:column`，`.hc-line` 固定 `min-height:38px`（预留两行，避免网络/运行信息换行导致卡片高低不一），`.hc-foot { margin-top:auto }` 把操作按钮压到底部。实测 1500/1200/1024/900/640 宽度下同排卡片高度完全一致（226 或 230px）。
- **CPU 型号采集**：`snap.cpu.model` 由本机 `os.cpus()[0].model`、远程/agent 的 `===CPUINFO===` 段（`/proc/cpuinfo` 的 model name / Hardware / Model）提供；前端只去掉 `Processor (series)`、`(R)`、`CPU`、`@xGHz` 噪声，保留真实厂商型号。**旧 agent 的采集脚本不含 CPUINFO**，需重跑一键安装器更新（2026-11-10 已对 netwatch / lan-1103 重装，型号分别为 Hygon C86 7151 / Hygon C86 7390）。
- **内存标称容量**：`MemTotal` 是内核可用内存，会少 1–2GB（本机 30837MB）。`nominalMemGb()` 向上取常见内存档位 `[1,2,4,6,8,12,16,24,32,48,64,...]`，本机显示 32GB、NetWatch 8GB、阿里云 2GB；不要再直接 `Math.round(totalMb/1024)`。
- **monitor-server.mjs 改动必须重启**：`systemctl restart my-homepage-monitor`（改 `monitor.config.json` 才是热加载）。
- **应用中心 ↔ 监控中心的对应关系（本机目录单向 + 可选双向同步）**：应用中心 `apps[].directory`（且 `exclude` 不为 true）会作为**本机主机**的自动跟踪目录并入监控（`homepageDirs`）；`remoteApps` 默认不会自动变成监控主机，远程主机需在监控设置里单独添加并配置该机目录——**2026-11-11 起勾选 `monitorSync` / `appSync` 可双向同步（见 §17）**。`monitor-server.mjs` 已监听 `scripts/apps.config.json`（600ms 防抖），设置页新增/删除/隐藏应用后自动 `reloadHomepageDirs()`，下一个 5s 采集周期生效，无需重启网关；日志出现「主页应用目录热加载完成」。反向的唯一“自动出现”来自主页端口探测：目录在 `/root/applications` 下且有监听端口的应用会被应用中心自动发现为「待补充」，与监控配置无关。
- **验证方式**：Playwright 从 `data/monitor/sessions.json` 注入 `mh_mon` Cookie（只读），轮询页用 `domcontentloaded` + `waitForSelector`；本轮截图脚本在 `/tmp`，项目内保留 `.verify/` 截图（u1–u5、nw-cpu、dirs-ui 等）。

### 16.3 本轮涉及文件

`src/components/MonitorView.vue`（副标题、主机卡）、`MonitorDetail.vue`（图表/排序/选择控件）、`MonitorHostEdit.vue`（生效目录展示）、`MonitorSettings.vue`（全局目录区）、`src/lib/monitor-charts.js`（自适应轴/移除 MarkLine 组件）、`src/components/PageHero.vue`（新增共享页头）、`src/style.css`（tab 字重/滚动条预留）、`glass-v2/assets/glass-v2.css|js|index.html`（同步图表与 tab 防跳）、`scripts/monitor-server.mjs`（effectiveDirs）。

---

## 17. 2026-11-11 增量：应用中心 ⇄ 监控中心 双向同步

用户需求：「应用中心手动添加应用时可选择同步到监控中心，自动同步应用信息并监测，反之亦然；运行期间因并发限制中断则过一段时间自动重试。」

### 17.1 机制（文件级双向同步，各写各的文件）

| 方向 | 触发（谁监听谁） | 标记字段 | 产物 |
|---|---|---|---|
| ① 应用中心 → 监控中心 | `monitor-server.mjs` fs.watch `apps.config.json`（已有 watcher 扩展）+ 启动时 + monitor.config 热加载后（自愈陈旧 PUT） | `remoteApps[].monitorSync: true`（sanitize 白名单放行） | 监控中心同 id SSH 主机：`address=应用 host`、`group` 按 env 映射（public→公网）、`gitDir` 有值则预置跟踪目录、`note` 提示待配凭据、`syncSource:'apps'` |
| ② 监控中心 → 应用中心 | `settings-server.mjs` fs.watch `monitor.config.json`（新增 watcher）+ 启动时 + 自家 POST /api/config 后（自愈陈旧整表保存） | `hosts[].appSync: true`（normalizeHost 白名单放行） | 应用中心同 id 远程应用：`healthUrl/url` 默认 `http://<地址>/`、`env` 按组公网/内网映射、`location=group`、`syncSource:'monitor'`，写盘后自动 `probe --no-fetch` |

同步规则（两侧一致）：
- **配对规则（2026-11-11 扩展）**：同 id 优先，id 未见时**按地址配对已有条目**（ssh 主机 `address` ↔ 应用 `host`；`syncSource==='apps'` 的主机不被其他应用地址抢占、`monitorSync`/`syncSource==='monitor'` 的应用不被其他主机地址抢占；一台主机每轮只被第一个 monitorSync 应用占用）。真实场景监控主机 id 与应用 id 常不同（如 network-monitor@10.8.14.200 ↔ netwatch），按地址配对使勾选即可建立关联而不产生重复条目。
- **事实源**：勾 `monitorSync` 的应用是共享字段（name/group/address ↔ name/group/env/host）的唯一事实源，匹配到（id 或地址）即回写；勾 `appSync` 的主机同理，但应用若同时勾了 `monitorSync` 则跳过回写（防两方向互抢形成回环）。
- **永不自动删除、也不复活**：取消勾选/删除源条目后，对侧已创建条目保留且不会自动重建（方向一只处理带 monitorSync 的条目，方向二只处理带 appSync 的主机）；要彻底移除先撤勾选，再手工删对侧条目。
- **自愈**：已同步条目被陈旧面板的整表 PUT/POST 覆盖丢失时，下次本方向触发（配置变更/自家保存/服务重启）自动补齐。
- **不触碰监控侧配置**：凭据/端口/采集方式/跟踪目录（除创建时按 gitDir 预置）永不被同步覆盖；应用自定义健康接口在地址未变时保留，地址变化才重生成默认值。
- **防回环**：两侧均「无 diff 不写盘」；只有真写盘才会触发对方 watcher，收敛后静止（实测 70s 日志计数 0/0）。
- **凭据不自动分发**：方向一创建的主机 `credReady=false` 显示「待配置凭据」，用既有「自动部署」（输密码一键免密+Agent）或监控设置补密钥后即开始采集。

### 17.2 中断自动重试（并发限制防护）

两侧各有一个同构 `makeSyncRetryer(tag, fn)`：
- **并发合并**：in-flight 期间的重复触发只记 `pendingAgain`，本轮跑完补一次（不并发重入）；
- **退避重试**：单次同步抛错（读写竞态/JSON 解析半截/写冲突等）按 **10s→30s→60s→120s→120s** 自动重试，最多 5 次，日志形如 `[monitor→apps] 同步中断，10s 后自动重试（1/5）：…`；新事件触发会重置退避立即执行；连续 5 次失败本轮放弃，等下次变更或重启。
- 实测：写坏 monitor.config.json 后 settings 侧依次打出 10s/30s/60s 重试日志、monitor 侧「热加载失败（保留旧配置）」，恢复文件后自动同步成功。

### 17.3 UI

- 应用中心设置面板：远程应用编辑弹窗底部「同步到监控中心」勾选（title 说明机制与删除语义）；外机/公网列表行加「已同步监控 / 来自监控」徽标；本机应用弹窗显示禁用勾选「监控自动跟踪」。
- 监控设置：`MonitorHostEdit` SSH 主机「采集方式」下方「同步到应用中心」勾选（草稿/直连两模式均可）；主机行摘要加「来自应用中心 / 同步到应用中心」徽标。
- glass-v2 未同步此功能（其设置弹窗本就未对齐主站，见 §8.8）。
- **同步检查面板（2026-11-11）**：设置面板标题栏「同步检查」→ `src/components/SyncCheckPanel.vue`（z-index 66）——实时 GET `/api/monitor/sync-check`（monitor-server 只读计算三段：**已同步配对** pairs（含待对齐 diffs，如「主机名 A→B」，重同步/下次配置变更后对齐）、**同步异常** unpaired（勾选了但找不到同 id/同地址对端）、**可同步候选** candidates（同地址且两侧都没勾））；「强制重同步」POST `/api/monitor/sync-run`（方向一立即重跑 + `utimes` 唤醒方向二，两端点均需会话/CSRF）；候选行「应用为主 / 主机为主」一键配对（前端分别 POST `/api/config` 勾 monitorSync、GET+PUT `/api/monitor/config` 勾 appSync，等价于 UI 手工勾选）。
- **已建立的真实配对（2026-11-11）**：network-monitor（应用）⇄ netwatch（主机，10.8.14.200），应用为主——主机名已由「NetWatch 服务器」回写为「NetWatch 网络监控」，凭据/agent 模式/跟踪目录未动；study-log-cloud⇄aliyun、log-gpt-agent⇄lan-1103 仍为检查面板候选，可一键配对（自行选择事实源方向）。

### 17.4 涉及文件与验证

- `scripts/monitor-server.mjs`（normalizeHost 白名单 + syncAppsToHostsOnce + makeSyncRetryer + watcher/main 挂载）、`scripts/settings-server.mjs`（MONITOR_CONFIG_FILE + sanitize 白名单 + syncHostsToAppsOnce + makeSyncRetryer + watcher + 启动/POST 挂载，顺带修正文件头过时注释）、`src/components/SettingsPanel.vue`（勾选 + 徽标 + normalizeEntry）、`src/components/MonitorHostEdit.vue`（勾选区 + `.sync-chk` 样式）、`src/components/MonitorSettings.vue`（hostSummary 徽标）。
- 生效方式：`./deploy.sh` + `systemctl restart my-homepage-settings my-homepage-monitor`。
- 实测通过：方向一创建（gitDir 预置目录、note、syncSource）、改名回写、方向二跳过路径（monitorSync 优先）、方向二创建（env=公网映射、probe 自动触发、apps.json 出现条目）、无回环、退避重试链条、清理无复活；Playwright 会话注入验证三处勾选渲染（`.verify/sync-1-appeditor.png`、`sync-2-hosteditor.png`）。
### 17.5 展示修正（2026-11-11 用户反馈三则）

- **同步列居中**：表格「同步」列 td 水平居中（主站 AppTable `.col-sync`、glass `.fg-col-sync`、glass-v2 `.gv-app-table td.gv-col-sync`——特异性 0-2-1 才能压过 `.gv-app-table td` 的 `text-align:left`（0-1-1），单纯 `.gv-col-sync` 会被压住；unslop `.app-table .col-sync`），表头本就居中。
- **附加端口只保留对外监听**：probe 的 `pickPrimary` 与 `preferExpected` 分支过滤 `p.external`——仅本机的附属监听（本站监控网关 8301）不再出现在「+8301」，四个前端共用同一份 apps.json 一致生效；主端口的「仅本机」标注保留不变。
- **远程真实目录**：远程条目输出 `directory = apps.config 的 gitDir`（未配置为 null），「服务器 / 目录」列两行展示「位置 · 主机」+ 可复制目录行（主站 AppTable `.dir-stack`；AppCard 位置行保留展示、目录独立 fact 行可复制；三份静态拷贝 unslop/glass/glass-v2 的 `dirCellHtml`/`buildDir` 同步改——表格与卡片共用同一函数，一处改两端生效）。改这类展示仍是四处都要改（见 §7.3.1 四拷贝纪律）。

- 踩坑补充：#18 的 `cp -i` 别名再次咬人——恢复配置用 `cat 文件 > 目标` 重定向最稳；验证 apps.json 更新要等探测跑完（远程 git 检查失败重试会使单轮 probe 长达 ~14s），立刻 curl 会读到上一轮产物。

---

## 18. 2026-11-11 增量：全量系统测试与 4 处修复

### 18.1 测试覆盖（全部通过）

- **服务与基础设施**：五个 systemd 单元 active + enabled；nginx 两处 server 块 location 齐全；8300/8301 仅回环。
- **探测链路**：完整探测 12 应用（fetch 9 仓并发 6 ≈5.3s，3 台外机 git 检查 ≈8s），`public/` 与 `www/` 产物 md5 一致；线上机语义（aliyun production）正常。
- **设置 API**：三个入口（直连/两个 Host）返回一致；非法 healthUrl / 重复 id 均 400；往返保存无损；`.bak` 自动备份。
- **监控 API**：summary（4 主机在线）、sync-check（1 配对 + 2 候选）、config（effectiveDirs）、history 1h/24h/7d + 非法 range 400、procs、dirs/history、alerts、audit、401 门禁、CSRF 403、agent push/install.sh token 门禁。
- **终端 WS**：local + netwatch（agent 模式主机）echo 回显 PASS。
- **前端**：`npm run build` 通过；主站表格 12 行、监控 4 主机卡、详情 6 canvas、设置面板、同步检查面板；/glass/（12 行）、/unslop/、/glass-v2/、/monitor/ stub 重定向——五端点 0 控制台/页面错误（Playwright 会话注入法，脚本 `.verify/sweep-systemtest.cjs`）。

### 18.2 修复的 bug（均已重启生效 + 回归验证）

1. `connectSSH` 密码认证「加密存档」路径 `rec` 未定义 → ReferenceError（踩坑 #29）。
2. 远程采集 `df -kPT` 挂载点混入配额列，`mnt: "22% /"` → 告警 key 漂移 + UI title「22% / 20.4%」（踩坑 #30）；重启后三台远程主机 mnt 已干净。
3. 设置面板 POST /api/config 会丢弃顶层 `order` 字段（§6.4 文档化功能）——改与 `$comment` 同款保留机制：请求未携带时兜底保留、显式 `order: []` 可删除、GET /api/config 现在返回 order。
4. 登录 Set-Cookie 回退值 `|| 12` 与会话 TTL 8760h 不一致 → 统一用 `sessionTtlMs()`。

### 18.3 优化项执行（2026-11-11 第二轮，全部已落地并回归）

- **远程主机容器归属（已实现）**：采集 awk END 块 PRC 行追加第 8 列 `cg`（docker cgroup id），shell 段新增 `===DOCKER===`（`docker ps -a --format`，无 docker 静默跳过）；`parseRemoteOutput` 回填 `p.cg` 并解析容器表（id12→{name,image,dir}，compose working_dir 同本机口径）；`buildSnapshot` 改用主机感知映射 `dmap = counters.docker ?? 全局 dockerMap`（本机采集体无 docker 字段 → 仍走中心表）。**生效范围**：SSH 拉取主机（aliyun）下一轮 20s 探测即生效（实测新脚本对 aliyun 实跑输出结构完整）；agent 主机需重装采集器才上报 cg/容器表——**当前三台远程机均无容器（netwatch 无 docker、aliyun/1103 有 docker 0 容器），暂不重装**，旧 agent 7 列 PRC 向后兼容（cg 留空）。
- **历史清理改为遍历磁盘**（`cleanHistoryRetention`）：`readdirSync(HISTORY_DIR)` 逐主机清过期 `.jsonl`，清空的目录 `rmdirSync`，已删主机残留随之按保留期清除；`applyCollectors` 同时释放已删主机的内存态（history/hostState/procDetailCache）。
- **离线分钟点补齐**：抽出 `rollMinute(h, upToTs, hostId)` 共享助手（正常路径聚合窗口均值，语义与原实现一致；空窗口产出全 null 分钟点），`pushHistory`/`pushHistoryOffline` 共用——离线期间 JSONL 保持连续（图表断线可见而非整段缺失）；**>24h 空洞直接快进**不批量补 null。
- **坏 JSON 统一 400**：monitor-server 新增 `readJsonBody(req, res)`，login/provision/password/config PUT 四个写路由不再把解析错误抛成 500（settings-server 外层 catch 本就返 400，无需改）。
- **保存轮询改用服务端时钟**：POST /api/config 响应增加 `serverTime`，SettingsPanel `savedAt = data.serverTime ?? Date.now()`——与 probedAt（服务端 ISO）比较不再受浏览器时钟偏差影响。
- **glass-v2 补 appSync 勾选**：SSH 主机表单「采集方式」下新增「同步到应用中心」（`data-k="appSync"`，checkbox 分支 `h[k] = inp.checked`），保存随 hosts 原样 PUT、`normalizeHost` 白名单落盘；布局仍为平铺表单版（紧凑列表重构继续搁置，见 §8.8）。
- 主包 gzip 68.9KB（较 §2 基线 56KB 增长来自 SyncCheckPanel/批量终端等新增组件），仍在轻量范围内。

### 18.4 仍搁置的（低价值/需需求驱动）

- glass-v2 设置弹窗的**紧凑列表重构**（与主站 MonitorSettings/MonitorHostEdit 完全对齐）——功能层面已补齐 appSync，纯布局 parity 留待该端点有实际使用诉求时再做。
