# my-homepage · 我的应用导航

部署在这台服务器上的个人应用展示主页：以**表格 / 卡片**两种视图列出 `/root/applications` 下所有自研应用与**云服务器上的公网应用**的名称、简介、**实际访问端口/地址**、部署位置与 GitHub 地址，支持**手动排序**（拖拽 / 上下移动）以及按名称 / 端口 / 运行状态 / 同步状态排序。端口与运行状态、**源码是否已同步至 GitHub** 由服务端定时探测：**端口/状态每 3 分钟、完整 git 同步每 5 分钟**，页面每 60 秒轮询刷新，应用换端口、上下线、源码有未提交/未推送改动都会自动反映到主页，无需改前端代码。

- 技术栈：Vue 3 + Vite（构建产物为纯静态文件），零第三方运行时依赖
- 线上地址：`http://<服务器IP>/`（nginx 80 端口托管）

> 🤖 **AI Agent / 接手开发者请先读 [AGENTS.md](./AGENTS.md)** —— 项目完整交接记忆：架构与数据流、配置规格、探测与设置 API 细节、部署链路、**踩坑记录**、设计决策史与常见任务配方。

## 目录结构

```
my-homepage/
├── index.html / package.json / vite.config.js
├── src/
│   ├── App.vue               # 布局、数据轮询、主题、搜索、视图切换
│   ├── style.css             # 设计变量（浅色/深色）
│   ├── lib/app-utils.js      # 访问地址拼接、复制等工具
│   └── components/
│       ├── AppTable.vue      # 表格视图
│       └── AppCard.vue       # 卡片视图
├── scripts/
│   ├── apps.config.json      # ★ 应用元数据（手工维护，唯一需要编辑的文件）
│   └── probe-apps.mjs        # ★ 端口探测器（生成 apps.json）
├── systemd/                  # 探测定时器单元（快速 3 分钟 / 完整 5 分钟）
├── deploy.sh                 # 一键发布
└── public/                   # favicon、apps.json（构建时随 dist 拷贝）
```

## 常用命令

```bash
npm install          # 安装依赖（仅构建时需要）
npm run probe        # 手动跑一次端口探测
npm run dev          # 本地开发（5173）
npm run deploy       # 一键发布：构建 → 探测 → 同步 /root/applications/my-homepage/www → 重载 nginx
```

## 服务管理（systemd 开机自启）

项目已配置为**开机自启**，由以下 systemd 单元组成：

| 单元 | 作用 |
|---|---|
| `my-homepage-settings.service` | 首页设置面板的后端 API（127.0.0.1:8300） |
| `my-homepage-probe-quick.timer` | 每 3 分钟探测端口 / 运行状态（不 fetch git，约 0.3 秒） |
| `my-homepage-probe.timer` | 每 5 分钟完整探测，含 git fetch（约 6 秒） |

手动控制脚本（需 root）：

```bash
./scripts/start.sh      # 启用开机自启并立即启动，随后跑一次探测
./scripts/restart.sh    # 重启全部服务（不改变自启状态）并立即探测一次
./scripts/stop.sh       # 停止并取消开机自启 = 永久关闭（重启服务器也不会起来）
```

> **stop 是永久关闭**：执行 `systemctl disable --now`，重启服务器后不会自启；恢复请执行 `start.sh`。
> 主页是静态文件、由共享 nginx（80 端口）托管，因此 stop 后**页面仍能打开**，但数据不再更新、设置面板保存会失败（API 返回 502）。nginx 还承载其他历史代理路径，脚本不会去停它。
> 若在「永久关闭」状态下执行 `restart.sh`，服务会临时运行，并在输出中提示重启服务器后仍不会自启。

## 如何新增一个应用

1. 把应用放到 `/root/applications/<目录名>/` 并启动（确保有监听端口）；
2. 在 `scripts/apps.config.json` 追加一条（`id` 必须等于目录名）：

```json
{
  "id": "my-new-app",
  "name": "我的新应用",
  "description": "一句话简介",
  "directory": "/root/applications/my-new-app",
  "expectedPort": 9000,
  "kinds": ["web"],
  "env": "lan",
  "github": "https://github.com/guojiaxian/my-new-app",
  "tags": ["标签"],
  "icon": "🚀"
}
```

3. 执行 `npm run deploy`（或只跑 `npm run probe`——不改前端代码时无需重新构建）。

> 技术栈（`languages` / `frontend` / `backend`）通常不用手写：探测器会根据依赖清单与 README 自动识别；需要修正时在设置页填写即可。

> 漏登记的应用只要在监听端口，也会被**自动发现**并以「待补充」形式出现在主页，端口照常可点；之后补一条配置即可。

## 端口探测原理

`scripts/probe-apps.mjs` 解析 `ss -tlnp` 的所有 TCP LISTEN 端口，读取各监听进程的 `/proc/<pid>/cwd`（cmdline 兜底），进程工作目录位于 `/root/applications/<目录>` 内即认定该端口归属此应用；进程匹配不到时退回探测 `expectedPort` 的 TCP 连通性。结果合并元数据写入 `public/apps.json` 与线上 `/root/applications/my-homepage/www/apps.json`，含实际端口、附加端口、是否对外监听（仅本机监听会标注）、运行状态与探测时间。

定时器安装（root）：

```bash
cp systemd/my-homepage-probe{,-quick}.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now my-homepage-probe.timer my-homepage-probe-quick.timer
```

## 设置页面（免改配置文件）

顶栏 ⚙ 按钮打开设置面板，可直接修改并保存：

- **页面信息**：站点名称（顶栏 + 浏览器标题）、首页主/副标题；
- **本机应用**：名称、图标、期望端口、应用形式（Web / APP / 小程序 / 电视 / CLI，可多选）、主要语言、前端框架、后端框架、部署位置（内网 / 公网）、标签、服务器目录、GitHub、简介，支持新增 / 删除条目、勾选「在主页隐藏」（exclude）；
- **云服务器应用**：名称、健康接口 URL、访问 URL、位置、主机、应用形式、主要语言、前端框架、后端框架、部署位置、GitHub、标签、简介，支持新增 / 删除。

保存后自动写入 `scripts/apps.config.json`（原文件备份为 `.bak`）并**立即重跑一次探测**，几秒内页面生效，无需登录服务器。本机应用的「期望端口」旁会显示当前**探测到的实际端口**；两者不一致时点「采用」可一键写回配置。

实现：`scripts/settings-server.mjs`（零依赖 Node，仅监听 `127.0.0.1:8300`，nginx 将 `/api/` 反代到它），由 `my-homepage-settings.service` 常驻；服务端只做配置文件的校验与原子写入（不执行 shell、不触碰应用目录）。注意：该接口对局域网开放（与各应用自身「无登录」的信任级别一致），如需收紧可在 nginx 层加访问控制。

## 立刻同步

工具栏右侧的「立刻同步」按钮会调用 `POST /api/probe`，在后台立即执行一次**完整探测**（端口 + git fetch + 远程健康接口）。探测期间按钮显示「同步中…」并禁用，完成后页面自动刷新。它与完整定时探测共用同一个脚本，会并发 fetch 各仓库，通常约 6 秒完成。

页脚「最后探测」固定按**北京时间**显示，取的是探测**完成**时刻（不是开始时刻）。

## 远程应用探查（云服务器）

`scripts/apps.config.json` 顶层的 `remoteApps` 数组登记部署在 external 主机（如阿里云）上的应用，探测时通过其健康接口做 HTTP 探查（6s 超时）：

```json
"remoteApps": [
  {
    "id": "study-log-cloud",
    "name": "StudyLog 公网版",
    "healthUrl": "http://47.95.140.199:3000/api/v1/health",
    "url": "http://47.95.140.199:3000",
    "location": "阿里云",
    "host": "47.95.140.199",
    "github": "…", "tags": ["公网"], "icon": "☁️"
  }
]
```

- **在线判定**：HTTP 2xx 且（若返回含 `status` 字段）值为 `ok`；否则显示「未运行」，悬停可见原因（HTTP 码 / 超时 / 连接错误）
- **版本号**：取健康响应 JSON 的 `version`（兼容 `data.version`），显示为应用名旁的标签
- 悬停状态徽标可看明细：延迟、数据库就绪状态、已运行时长、内存占用（取决于接口返回哪些字段）
- 远程应用不做 git 同步检查，「服务器 / 目录」列显示部署位置（如 `阿里云 · 47.95.140.199`）

## 源码同步检测（git）

探测器对每个应用目录（含自动发现的）执行 git 检查，结果随 `apps.json` 的 `git` 字段下发：

1. **fetch 校准**：默认**并发 6 个仓库**执行（可用 `PROBE_FETCH_CONCURRENCY` 调整），只 fetch 当前分支所属远端（通常是 `origin`）、不拉 tags，SSH BatchMode + 连接复用，单仓 20s 超时；保证 ahead/behind 基于最新远端快照。网络不通时回退上次快照并在悬停提示中标注「远端不可达」。手动运行 `node scripts/probe-apps.mjs --no-fetch` 可跳过网络步骤；
2. **工作区核对**：`git status --porcelain` 统计未提交（已跟踪文件改动）与未跟踪文件数；
3. **推送核对**：`git rev-list --left-right --count @{upstream}...HEAD`（无分支上游时退回 `origin/HEAD`）得出未推送（ahead）/ 未拉取（behind）提交数。

状态含义（即主页「同步」列的 chip）：

| 状态 | 含义 |
| --- | --- |
| ✅ 已同步 | 工作区干净且与远端一致 |
| 🔴 未提交 N | 有 N 个已跟踪文件的修改未 commit（源码未进 git） |
| 🟠 未推送 N | 本地有 N 个 commit 未 push |
| 🟠 未拉取 N | 远端有 N 个新 commit 未 pull |
| 🟠 未跟踪 N | 有 N 个未加入版本控制的文件 |
| ⚪ 无 Git 仓库 / 未关联远端 / 检查失败 | 无法核对，悬停可见原因 |

**线下应用**（纯 APP / 小程序 / 电视 / CLI，无 Web 服务）：`kinds` 不含 `web`（如 `["app"]`）时，主页状态显示灰色「**线下应用**」，不做端口探测、不产生访问链接。只要 `kinds` 含 `web`，即使同时是 APP 也会正常探测 Web 端口。此类应用仍参与 git 同步检查（有仓库时）。

主页顶部统计条实时汇总「N 个源码未同步」；配置里没填 `github` 但仓库有 `remote.origin.url` 的应用会自动生成 GitHub 链接兜底。

## 应用形式、技术栈与部署位置

每条应用可配置以下信息，均在首页展示、可在设置面板修改：

- **应用形式** `kinds`：`web`（Web）、`app`（APP）、`miniapp`（小程序）、`tv`（电视）、`cli`（CLI），**可多选**。首页显示为灰色 chip。是否探测由它决定：含 `web` 就探测，不含则视为线下应用。
- **技术栈**：`languages`（主要语言）、`frontend`（前端框架）、`backend`（后端框架），均为数组。本机应用由探测器从 `package.json` / `requirements.txt` / `pyproject.toml` / `go.mod` / `build.gradle` / `app.json` / README 等自动识别；设置页可手动覆盖。远程应用不在本机目录，需在设置页手动填写。
- **部署位置** `env`：`lan`（内网，蓝色）或 `public`（公网，橙色）。本机应用默认 `lan`，云服务器应用默认 `public`。
- **HTTPS** `https`：本机应用可在设置面板勾选「使用 HTTPS」，首页访问链接会拼成 `https://<当前主机名>:<端口>`；配置对应 `"https": true`，缺省为 `false`（http）。远程应用直接使用配置的 `url`，不需要该字段。

配置缺省时自动推断：旧字段 `type: "app"` 的条目默认 `["app"]`，其余默认 `["web"]`；部署位置按所在区块推断。技术栈字段留空时显示自动识别结果，手动填写后以手动值为准。例如既有网页又有 APK 的应用可同时勾选 Web 与 APP，仍会探测 Web；电视/CLI 不勾 Web 时按线下应用处理。

自动识别是启发式的：它能覆盖当前这些项目，但新增应用若目录结构特殊，结果可能在设置页修正。识别不到的项显示「无」。

## 运行状态

| 状态 | 颜色 | 判定 |
| --- | --- | --- |
| 运行中 | 绿 | 端口正在监听；远程应用的健康接口正常 |
| 未运行 | 红 | 端口未监听；远程应用的健康接口不可达 |
| 线下应用 | 灰 | `kinds` 不含 `web` 的纯 APP / 小程序，不做探测 |

线下应用不会发起端口探测，也不显示访问链接；远程应用同样统一使用「运行中 / 未运行」文案。

## 排序

### 手动排序（默认顺序）

排序下拉选「手动 / 默认顺序」时可直接排列应用：

- **表格视图**：按住行首的 ⠿ 手柄拖拽到目标位置；
- **卡片视图**：卡片右上角 ↑ / ↓ 按钮上下移动，或直接拖拽卡片；
- 手动顺序保存在**本浏览器**（localStorage），跨会话保留，新发现的应用自动排在最后；工具栏出现 ↺ 按钮可一键清除、恢复默认。

**全局默认顺序**：编辑 `scripts/apps.config.json`，在顶层加 `"order": ["study-log", "cloud-monitor", …]`（id 数组），跑一次 `npm run probe` 即对所有访客生效；未列出的应用按原相对顺序排在后面。浏览器里的手动排序优先于该全局顺序。

### 自动排序

- **表格视图**：点击「状态 / 应用 / 访问地址 / 同步」表头排序，再次点击同一表头切换正反方向（表头高亮 + ▲/▼ 指示）；
- **卡片视图**：使用工具栏的「排序」下拉（两种视图共用同一排序状态），旁边的 ↑/↓ 按钮切换方向；
- 排序规则：名称按中文拼音；端口升序（未监听的排最后）；运行状态按「运行中 → 未运行 → 线下应用」；同步状态按问题严重度排序（未提交 → 无仓库 → 未推送 → 未拉取 → 未跟踪 → 检查失败 → 未关联远端 → 已同步）。

自动排序时隐藏拖拽手柄（仅默认顺序下可手动排列）；切换回「手动 / 默认顺序」即恢复手动排列。

## nginx 配置（80 端口）

`/etc/nginx/conf.d/default.conf` 指向 `/root/applications/my-homepage/www`（`listen 80 default_server`，SPA 回退 + gzip + 静态资源缓存）。原配置备份于 `/etc/nginx/conf.d/default.conf.bak`。

## 修改站点信息

站点名称、GitHub 链接、一句话介绍在 `src/App.vue` 顶部；浏览器标题在 `index.html`。修改后执行 `npm run deploy` 生效。
