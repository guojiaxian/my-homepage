# AGENTS.md · my-homepage 项目交接记忆

> 面向接手本项目的 AI Agent / 开发者：读完这一份即可上手，无需再翻聊天记录。
> 最后更新：2026-11-03 · 文档随代码演进，改功能时请同步更新本文。

---

## 1. 这是什么

个人应用展示主页（Vue 3 单页应用），列出部署在本机 `/root/applications` 下的自研应用**以及云服务器上的公网应用**，展示：名称、简介、实际访问端口、部署位置/目录、GitHub 地址、运行状态、git 源码同步状态。

核心设计目标：**应用信息与状态全自动维护**——端口、上下线、源码同步情况由服务端定时探测，增删应用/改信息通过首页设置面板完成，日常无需登录服务器改文件。

- 线上地址：`http://<本机IP>/`（本机 `10.8.11.4`，nginx 80 端口，`default_server`）
- 项目根目录：`/root/applications/my-homepage`（已纳入 git，origin `github.com:guojiaxian/my-homepage`；改动请及时 commit/push）
- 部署产物目录：`/root/applications/my-homepage/www`（项目内）
- 旧路径 `/root/gjx-homepage`：为兼容保留的**软链接**，指向新目录；确认无人依赖后可 `rm /root/gjx-homepage`（若 shell 正停在该路径，先 `cd` 到别处）

> ⚠️ 部署目录位于 `/root` 之下仍能正常访问，是因为本机 nginx 配置为 `user root;`（worker 也以 root 运行）。**若日后把 nginx 降权为 `nginx` 用户，站点会立刻 403**——届时需把 webroot 移出 `/root`（可用 `move-project.sh --webroot`）或放开目录遍历权限。

> ℹ️ **本项目自身也作为普通应用登记在 `apps[]` 里**（id `my-homepage`，`expectedPort: 80`）。它由 nginx 托管，进程 cwd 不在项目目录，因此走「`expectedPort` TCP 兜底」探测；「是否对外监听」从 `ss` 端口表判定，不会误标「仅本机」。副作用：若此时跑 `npm run dev`，cwd 匹配会优先命中 5173 的开发实例（主页临时显示 :5173，属正常）。

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
| 探测定时器 | `my-homepage-probe-quick.timer` 每 3 分钟（`--no-fetch`）；`my-homepage-probe.timer` 每 5 分钟（完整，含 fetch） |
| 前端轮询 | 每 60 秒拉一次 `apps.json`；页面回到前台时立即刷新 |
| 已登记应用 | 11 个（含 2 个离线应用（纯 APP）+ 1 个公网远程） |

**运行中的 systemd 单元（均已 enable）**

```bash
systemctl status my-homepage-settings.service   # 设置 API，常驻
systemctl status my-homepage-probe.timer        # 每 5 分钟完整探测（含 fetch）
systemctl status my-homepage-probe-quick.timer  # 每 3 分钟快速探测（--no-fetch）
```

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
systemctl restart my-homepage-settings           # 改了 settings-server.mjs 后必须重启

./scripts/start.sh      # 启用开机自启并启动（+ 立即探测一次）
./scripts/restart.sh    # 重启两个服务（不改变自启状态）
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
│   ├── start.sh               # 手动启动：enable --now + 立即探测一次
│   ├── restart.sh             # 手动重启（不改变自启状态）
│   ├── stop.sh                # 手动停止：disable --now = 永久关闭（重启不自启）
│   └── move-project.sh        # 项目目录迁移（自动修正 systemd/文档/可选 webroot 路径）
├── systemd/
│   ├── my-homepage-probe.service / .timer     # 每 5 分钟完整探测（含 git fetch）
│   ├── my-homepage-probe-quick.service / .timer  # 每 3 分钟快速探测（--no-fetch）
│   └── my-homepage-settings.service           # 设置 API 常驻
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
│       └── SettingsPanel.vue  # ★ 设置面板（页面信息 + 应用增删改）
├── glass/                     # ★ 独立毛玻璃页面（纯 HTML/CSS/JS，不参与 Vite 构建）
│   ├── index.html
│   └── assets/glass.css, glass.js
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
| `src/**`（前端） | `./deploy.sh`（须重新构建） |
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
  "env": "public",                                          // 部署位置，缺省 public
  "languages": ["JavaScript/Node.js"],                      // 主要语言（远程应用手填）
  "frontend": ["Vue 3"],                                    // 前端框架
  "backend": ["Fastify"],                                   // 后端框架
  "github": "…", "tags": ["公网"], "icon": "☁️"
}
```

健康接口期望返回（StudyLog 实际返回示例）：

```json
{"status":"ok","dbReady":true,"rssMb":78,"uptimeSec":1088946,"version":"1.1.0","time":"…"}
```

解析规则：`version`（兼容 `data.version`）→ 应用名旁 `v1.1.0` 标签；`dbReady`/`uptimeSec`/`rssMb` → 状态徽标悬停明细；**在线判定 = HTTP 2xx 且（若有 `status` 字段）值为 `ok`**。远程应用不做 git 同步检查。

### 6.3 `page` — 页面文案（设置面板可改）

```json
"page": {
  "siteName": "我的应用导航",       // 顶栏 + document.title + 页脚
  "heroTitle": "我的应用",
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
4. **主端口选择**（`pickPrimary`）：`expectedPort` 命中则锚定它 → 否则取最小的**对外**监听端口 → 全为仅本机时取最小值。其余端口进 `extraPorts` 显示为 `+2222, 18099`。
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

> `git` 字段对远程应用为 `null`；`appOnly` 条目（`kinds` 不含 `web`）的 `port` 为 `null` 且不做端口探测。

---

## 8. 前端实现要点

### 8.1 数据与状态（`src/App.vue`）

- `shallowRef` 存 `apps`，`page` 单独 ref（`watch(siteName)` 同步 `document.title`）
- 轮询 60s（静默模式不显示 loading）；`visibilitychange` 回前台立即刷
- `onSaved(savedAt)`：设置保存后先刷一次，再每 1.5s 轮询直到 `probedAt > savedAt`（上限 40 次）→ 再刷一次
- `syncNow()`：「立刻同步」按钮 → `POST /api/probe` → 每 2s 轮询直到 `probedAt > 服务端 startedAt`（上限 90 次）→ 刷新；期间按钮禁用并显示「同步中…」
- 页脚「最后探测」固定按 `Asia/Shanghai` 显示（避免浏览器时区不同导致偏差）
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
- **内网 = 蓝（`--accent`） / 公网 = 橙（`--amber`）**，四种呈现同时生效：名称旁 `env-chip` 标签、表格行 `td:first-child` 左边色条、卡片左边框、应用图标底色（`icon-net`）。判定以 `app.env` 为准，旧数据缺 `env` 时回退 `app.remote`
- **应用形式 chip**：`kind-chip`（Web / APP / 小程序 / 电视 / CLI，可多选），按类型配色：Web 蓝、APP 绿、小程序青、电视紫、CLI 灰；表格显示在名称下方标签行，卡片显示在底部标签行
- **技术栈文本**：表格在应用形式 chip 后显示最多两行 `语言 · 前端 · 后端`，在应用列固定宽度内垂直居中，超出两行省略、悬停看完整；卡片有独立「技术栈」行
- **业务标签 `tags`**：仍保存在配置与设置页中，但当前不在首页表格/卡片展示（避免与形式/技术栈重复）
- 状态徽标：**运行中（绿）/ 未运行（红）/ 离线应用（灰）**；远程应用同样统一为运行中/未运行，离线应用为纯 APP / 小程序 / 电视 / CLI、不做探测
- git 同步 chip：已同步绿、未提交红、未推送/未拉取/未跟踪橙、无仓库等灰
- 表格布局：容器 `max-width: 1440px`；行内容 **`vertical-align: middle`**，表头 **`text-align: center`**；应用列固定 `width/min-width: 340px`；简介列 `-webkit-line-clamp: 3` + 固定 `height: 63px`；`.app-meta` 同为 63px（名称行 + 两行技术栈约 60px）→ **每行高度严格一致**（约 92px）
- 移动端 `≤640px` 单列，`≤900px` 表格压缩列宽并横向滚动

### 8.4 设置面板（`src/components/SettingsPanel.vue`）

`Teleport` 到 body 的模态框。三区块：页面信息 / 本机应用（增删）/ 云服务器应用（增删）。每个应用条目可设 **应用形式**（`kinds` 多选：Web / APP / 小程序 / 电视 / CLI）、**主要语言 / 前端框架 / 后端框架**（逗号分隔数组）和 **部署位置**（`env`：内网 / 公网）；本机应用另有 **使用 HTTPS**、`exclude` 两个勾选。**是否探测由形式决定**：勾了 Web 就探测，不勾则视为离线应用（面板有提示）。本机应用的技术栈字段留空时，面板会从 `apps.json` 带入自动识别结果，保存后变为手动值；远程应用需手填。本机应用「期望端口」旁会显示 `apps.json` 中的**实际探测端口**，与配置不一致时点「采用」可写回。缺省值在面板加载时自动补全（本机 `lan`、远程 `public`；分类对旧 `type: "app"` 回退为 `["app"]`）。保存逻辑见 §8.1 `onSaved`，**保存后立即关闭，探测在后台跑**。

### 8.5 独立毛玻璃页面（`glass/`，访问 `/glass/`）

完全独立于 Vue 主站的静态页面，纯 HTML + CSS + JS，**不参与 Vite 构建、不读取 `apps.json`、不依赖任何第三方库**。

- 入口 `glass/index.html`，样式 `glass/assets/glass.css`，脚本 `glass/assets/glass.js`；全部类名/变量/存储键使用 `fg-`、`--fg-`、`fluxglass:*` 命名空间。
- 视觉：环境层径向渐变光斑 + 噪点颗粒，卡片用 `backdrop-filter: blur(22px) saturate(165%)`、半透明渐变、内高光、三层阴影；含浅色 / 深色主题（localStorage `fluxglass:theme`）。
- 交互：清单勾选与进度、指标计数、圆环分段、30 天趋势图悬停、实时流模拟、搜索面板（`Ctrl/Cmd+K`）、主题切换。
- 响应式：≤1180px 调整栅格，≤900px 主卡单列，≤480px 指标卡单列；≤760px 模糊半径降至 16px；`prefers-reduced-motion` 下关闭光斑漂移与入场动效；不支持 `backdrop-filter` 时降级为高不透明度背景。
- 部署：`deploy.sh` 的 `rsync --delete` 只覆盖 `www/`，**不会删除 `glass/`**；nginx 在两处 server 块各加了 `/glass/` location（`root /root/applications/my-homepage` + `try_files … /glass/index.html`）。改完无需构建，刷新即生效。

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

**A. `/etc/nginx/conf.d/default.conf`** — `listen 80 default_server`，root `/root/applications/my-homepage/www`，含 SPA 回退、`/api/` 反代、`/assets/` 长缓存、`apps.json` no-cache，以及独立页面 `/glass/`（`root /root/applications/my-homepage`）。

**B. `/etc/nginx/nginx.conf` 内的 `server { listen 80; server_name 127.0.0.1; }`** — 这是 paraportal 遗留配置块，携带 `/Platform`、`/visualization`、`/pushservice` 等到 `127.0.0.1:8080` 的代理。原始 `root` 指向**不存在的** `/opt/paratera/paraportal/gui/webapps/ROOT`。

已做的最小改动：`root` 改为 `/root/applications/my-homepage/www`，并补上 `/api/` 反代与 `/glass/` 独立页面 location。**不要删这个块**（会破坏 docker:8080 的代理路径）。

> `/glass/` 必须两处都配：`Host: 127.0.0.1` 走 `nginx.conf` 的块，局域网 IP 走 `default.conf`，否则会出现「一个入口能开、另一个 404」。两处都用 `root`（不是 `alias`）+ `try_files $uri $uri/ /glass/index.html`，`alias` 与 `try_files` 组合会导致静态资源 404。

备份：`/etc/nginx/conf.d/default.conf.bak`、`/etc/nginx/nginx.conf.bak`（另有本次新增的 `*.bak-glass-20261104`）

### 10.3 systemd

```bash
cp systemd/*.service systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now my-homepage-probe.timer my-homepage-probe-quick.timer my-homepage-settings.service
```

服务文件里 `ExecStart` 用的是绝对路径 `/usr/local/bin/node`。

### 10.4 服务生命周期与手动控制

三个脚本都在 `scripts/` 下，需 root，行为严格区分：

| 脚本 | 对 systemd 的作用 | 语义 |
|---|---|---|
| `start.sh` | `enable --now` 三个单元 + 跑一次 `probe --no-fetch` | 恢复开机自启并立即运行 |
| `restart.sh` | `restart` 三个单元 + 跑一次 `probe --no-fetch` | 重启，**不改自启状态**；若当前 disabled 会警告"重启后不会自启" |
| `stop.sh` | `disable --now` 三个单元 + 停掉可能在跑的 probe oneshot | **永久关闭**：重启服务器也不自启 |

关键事实：

- **主页是静态文件**，由共享 nginx（80 端口）托管，且同一 nginx 还承载 `/Platform` 等历史代理，因此 `stop.sh` **不动 nginx**。停止后页面仍能打开，但 `apps.json` 不再更新、设置面板保存失败（`/api/config` 返回 **502**）。
- 当前四个服务（`my-homepage-settings`、`my-homepage-probe.timer`、`my-homepage-probe-quick.timer`、`nginx`）均为 `enabled`，开机自启已生效。核对：`systemctl is-enabled <unit>`。
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
| 保存异步 + `--no-fetch` | 同步等待 GitHub fetch 导致保存卡 27 秒 |
| fetch 串行 → 并发 6 + 连接复用 | 实测 10 仓串行约 37 秒，并发后完整探测约 6 秒；加锁避免与 3 分钟快速探测同时写 `apps.json` |
| 拖拽仅手柄触发 | 用户反馈点击卡片会触发拖拽 |
| 内网蓝 / 公网橙 | 用户要求「内网和公网区分明显，可用颜色」 |
| 3 行简介 + 固定行高 | 用户要求「简介过长换行、每行高度一致」；超 3 行截断（悬停看全文）是行高一致的必要代价 |

---

## 13. 当前应用清单（2026-11-03 探测）

| id | 名称 | 类型 | 端口/地址 | git |
|---|---|---|---|---|
| cloud-monitor | 云计算监控大屏 | 本机 | 18001 | synced |
| storage-monitor | 存储集群监控大屏 | 本机 | 18002 | synced |
| study-log | StudyLog 成绩记录 | 本机 | 3000 | synced（曾 dirty） |
| tv-show | 数智中心大屏聚合平台 | 本机 | 18000 | **dirty** |
| expense-assistant | 财务报销附件助手 | 本机 | 19000 | synced（**曾无仓库**，后补建） |
| wedding-plan | 备婚计划 | 本机 | 19002 | synced |
| network-monitor | NetWatch 网络监控 | 本机 | 18003（+2222, 18099） | **dirty** |
| jianji-ledger | 简记 · 账本 | 离线应用（kinds: app） | — | no-repo |
| time-logger | 时间记录器 | Web + APP（kinds: web, app） | 19001（https） | synced |
| study-log-cloud | StudyLog 公网版 | 远程（阿里云） | http://47.95.140.199:3000 · v1.1.0 | — |
| my-homepage | 我的应用导航（本站） | 本机（nginx 托管） | 80 | synced（已纳入 git） |

> 状态会随时变化，以上仅为撰写时快照。以 `curl -s http://127.0.0.1/apps.json` 为准。

**已知的应用侧问题**（不是主页的 bug，修应用即可，主页无需改动）：expense-assistant 根路径 500（`/docs` 正常）、wedding-plan 根路径 404（`/health` 正常）、network-monitor 根路径 404（其 UI 在 :8080）。

---

## 14. 常见任务配方

**新增一个本机 Web 应用**
1. 应用放入 `/root/applications/<id>` 并启动（有监听端口）；
2. 首页 ⚙ 设置 → 本机应用「＋添加」→ 填 id（=目录名）、名称、目录、期望端口 → 保存；或直接编辑 `apps.config.json` 后 `npm run probe`；
3. 前端 60 秒内自动出现。（漏登记也会被自动发现，标「待补充」）

**新增一个离线应用（纯 APP / 小程序）**
同上，但应用形式只勾选 APP / 小程序 / 电视 / CLI 中适用的项、不勾 Web（配置里写 `"kinds": ["app"]`），不需要期望端口；只要勾了 Web 就会照常探测。

**新增一个云服务器应用**
设置面板 → 云服务器应用「＋添加」→ 填 `healthUrl`（必填）、访问 URL、位置、主机，以及技术栈（主要语言 / 前端 / 后端，远程应用不会自动识别）；或编辑 `remoteApps` 后 `npm run probe`。

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

---

## 15. 禁止事项 / 注意事项

- ❌ **不要删除 `nginx.conf` 里的 paraportal `server` 块**——它承载 `/Platform` 等到 docker:8080 的代理。
- ❌ **不要把 `deploy.sh` 改成先构建后探测**。
- ❌ **不要给整行/整卡加 `draggable`**——只能是拖拽手柄。
- ❌ **不要在探测中执行 `git pull / checkout / reset / gc`**——只允许只读命令与 `fetch`。
- ❌ **不要用 `readFileSync` 读 `/proc/<pid>/cwd`**。
- ⚠️ `apps.config.json` 的 `id` 必须与目录名一致，否则端口归属匹配不到（会退回 TCP 兜底，丢失附加端口信息）。
- ⚠️ 改动前端后必须 `./deploy.sh`；只改配置/数据则 `npm run probe` 即可。
- ⚠️ 本项目已纳入 git（origin `github.com:guojiaxian/my-homepage`），改完请 commit/push，保持主页「同步」列干净。
- ⚠️ 本机 nginx 80 端口还承载其他历史代理路径，改 nginx 前务必 `nginx -t` 并保留 `.bak` 备份。
