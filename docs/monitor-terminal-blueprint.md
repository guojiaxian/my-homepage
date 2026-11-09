# 服务器监控看板 + Web SSH 终端 · 落地方案

> 交付对象：`my-homepage`（Vue 3 SPA + nginx + systemd，见 `AGENTS.md`）
> 撰写日期：2026-11-09 · 环境数据为当日实测
> 核心诉求：① 多机监控看板（含**指定目录程序性能跟踪**）② 点击服务器进入 Web SSH 终端 ③ 白底视觉、与现有风格一致、适度炫酷

---

## 0. 结论速览（TL;DR）

| 议题 | 结论 |
|---|---|
| 监控方案 | **自研轻量采集网关**（Node 直读 `/proc` + ssh2 免 Agent 远程采集）+ ECharts 看板，**不引入** Prometheus/Grafana/Netdata 全家桶（理由见 §2） |
| Web SSH | **xterm.js + ssh2 自建终端网关**（ttyd/Wetty 作对比项，GateOne 已停维护否决） |
| 目录跟踪 | `/proc/<pid>` 四路归属（cwd / exe / cmdline / cgroup），默认跟踪目录**直接复用主页 `apps[].directory`**，零重复配置 |
| 部署形态 | 新增 1 个回环网关服务 `127.0.0.1:8301`（HTTP+WS）+ 独立静态页 `/monitor/`（沿用 glass/unslop 模式，零构建）+ nginx **两处** server 块反代 |
| 安全 | 密码登录（scrypt）+ HttpOnly 会话 + 凭据 AES-256-GCM 加密存储 + 会话审计 + 空闲/时长/并发上限；8301 仅回环 |
| 视觉 | 白底（`--bg-soft #ffffff`）+ 现有全套设计变量；动效走合成层（transform/opacity），`prefers-reduced-motion` 全量降级 |

**为什么不选现成开源栈（一句话版）**：本需求的三块能力里，「按**目录**归属进程资源占用」是所有成熟方案的一等公民短板——process-exporter / Netdata 都按 cmdline 模板分组、不支持 cwd 维度；而我们的采集目标目录恰好就是 `/root/applications`（进程 cwd 即目录），自研归属逻辑只有 ~50 行，且审计/加密/统一风格全部内建。专业栈的价值（长期存储、复杂告警）通过预留 `/metrics` 与 webhook 扩展点兜底（§8）。

---

## 1. 现状盘点（2026-11-09 实测）

### 1.1 主机与资源

| 项 | 值 |
|---|---|
| 本机 | Kylin V10 · Hygon C86 7390 **32 核** · 内存 30G（已用 13G / 可用 13G）· 根分区 957G（21%） |
| 待纳管主机 | `10.8.14.200`（NetWatch 迁移目标，22 端口开放，**尚未配免密**）、`47.95.140.199`（阿里云，22 端口开放） |
| 本机 SSH | sshd active；`root@127.0.0.1` 免密可用（`~/.ssh/id_ed25519` 已在 authorized_keys） |
| 容器 | docker 运行 `open-webui`（0.0.0.0:8080→8080），需纳入容器维度采集 |
| 已装监控组件 | 无（node_exporter / netdata / ttyd 等均未安装） |
| npm 源 | 可达（实测 ssh2 1.17.0、ws 8.22.2、@xterm/xterm 6.0.0 可查询） |
| 进程规模 | `/proc` 约 510 个条目，全量扫描单次 <50ms，5s 采集周期无压力 |

### 1.2 权限模型

- 网关以 **root** 运行（与现有 probe/settings 一致）→ `/proc/<pid>/io`、`/proc/<pid>/fd` 可读，目录跟踪的 IO/句柄指标完整可用。
- 远程主机：推荐 root + 专用密钥（IO/句柄需 root）；用普通用户则自动降级（IO/句柄字段留空，UI 标注「需 root」），基础 CPU/内存/磁盘/网络不受影响。
- 现有约束（必须遵守）：nginx 改动**两处 server 块**同步（AGENTS.md 踩坑 #2）；`deploy.sh` 顺序不可动；不给整行/整卡加 draggable；主站前端保持零第三方运行时依赖（新依赖只进**网关服务**与**独立静态页**，见 §4.1）。

---

## 2. 选型对比与结论

### 2.1 监控方案对比（活跃度 / 协议 / 部署复杂度 / 可扩展性，5 分制）

| 维度 | ① 自研采集网关 + ECharts | ② Prometheus + node_exporter + process-exporter + Grafana | ③ Netdata | ④ Zabbix |
|---|---|---|---|---|
| 许可 | 自有（依赖均 MIT/Apache-2.0） | Apache-2.0 / Apache-2.0 / **Grafana AGPL-3.0** | **GPL-3.0**（二开/嵌入需注意） | AGPL-3.0 |
| 活跃度 | —（可控） | 5（事实标准） | 5 | 4 |
| **目录级进程跟踪** | **5**（cwd/exe/cmdline/cgroup 四路原生归属） | 2（process-exporter 按 cmdline 模板分组，不以 cwd 为一等维度；目录式分组要为每个目录写 cmdline 正则，解释器脚本 exe=python 时易失配） | 2（apps_groups.conf 同为 cmdline 模式） | 2 |
| 主机指标 | 4（/proc 直读，够用） | 5（生态最全） | 5（秒级、开箱即用） | 5 |
| 资源占用 | 5（Node 单进程 ~40-60MB） | 3（Prometheus+Grafana 常驻合计约数百 MB，视保留期） | 3（每机常驻 agent，约百 MB 级） | 2（Server+DB，最重） |
| 部署复杂度 | 4（1 个 systemd 服务 + 1 个静态页） | 2（3+ 个常驻组件 × 每台机器装 exporter） | 3（单机容易，嵌入统一风格难） | 1（最重） |
| 风格统一/嵌入 | 5（同套 CSS 变量，页面自绘） | 2（Grafana 独立 UI，iframe 嵌入+主题定制成本高） | 2（UI 强绑定，iframe 为主） | 1 |
| 终端集成 | 5（同一网关内建） | 1（无，需另接） | 1（无） | 1（自带但风格割裂） |
| 多机纳管 | 4（ssh2 免 Agent + 可选 Agent 推送） | 5 | 4（stream 复制） | 5 |
| 历史存储 | 3（内存环形 + JSONL 降采样，7-30 天；接 Prometheus 可无限） | 5（PromQL 任意回溯） | 4（自带 dbengine） | 5 |

**结论：选 ①。** 决定性理由按权重排序：
1. 「目录跟踪」是本需求核心差异化能力，②③④均需为每个目录手工维护正则/分组规则，且解释器脚本（python/node）cmdline 与目录无必然关联——而 cwd 归属天然解决；
2. 现有系统是「零依赖、systemd 常驻、nginx 回环反代」的极简哲学，方案①完全同构；②引入 3 个新常驻体系，与「个人主页 + 11 个应用」的体量失衡；
3. 看板点击进终端要求同一鉴权体系、同一审计管道——自建网关一处实现，拼接方案要跨 3 套系统打通；
4. 风格统一：Grafana/Netdata 的 UI 无法贴合现有 `src/style.css` 变量体系。

> ②的价值（任意回溯、复杂告警）不放弃：网关预留 `GET /metrics`（Prometheus 文本格式）与告警 webhook，未来可双写 Prometheus，前端不变（§8）。

### 2.2 Web SSH 方案对比

| 维度 | ① xterm.js + ssh2（自建网关） | ② ttyd | ③ Wetty | ④ GateOne |
|---|---|---|---|---|
| 语言/许可 | Node 前后端 / MIT | C 单二进制 / MIT | Node + node-pty / MIT | Python/Tornado / AGPL |
| 活跃度 | xterm.js 5（VS Code 同源，事实标准）；ssh2 4（持续发版，实测 1.17.0） | 4（持续发版） | 3（维护节奏放缓，近年偶有提交） | **1（已多年无实质维护，Python 2 时代架构）** |
| 集成方式 | **组件级**：xterm.js 嵌入看板页，WS 到自家网关 | iframe 嵌 `ttyd -W ssh user@host` | iframe / 独立端口 | iframe |
| 会话鉴权 | **自有会话**（与看板同一 Cookie，WS 升级时校验） | ttyd 自身 HTTP Basic（与看板体系割裂） | 自身 auth（割裂） | 自身 |
| 凭据管理 | ssh2 库内发起连接：密钥文件路径 / AES-GCM 加密密码，**不落明文** | 凭据即 ssh 命令参数或依赖远端 ssh-agent，中间层缺失 | 同左 | 自有体系 |
| 访问审计 | **可编程**：会话起止/时长/字节数/命令行捕获全部落审计日志 | 弱（pty 直通，无中间层） | 弱（同左） | 有（录屏插件） |
| 命令白名单/超时 | 网关层可做会话级空闲超时、硬超时、并发上限；白名单的现实边界见 §5.5 | 几乎不可 | 几乎不可 | 部分 |
| 二开成本 | 中（全部代码自有） | 低（但改不动） | 中低 | 高（陈旧栈） |

**结论：选 ①。** 需求明确要求「会话鉴权、凭据加密存储、访问审计、超时控制」——ttyd/Wetty 的 pty 直通架构在这四项上都是空白，其「零开发」优势在需求面前失效；GateOne 停止维护，按「不推荐停维护项目」原则否决。xterm.js + ssh2 与现有 Node 栈同语言，一个网关服务同时承载**监控 API + 终端 WS**，部署面最小。

---

## 3. 架构设计

### 3.1 总体拓扑

```
浏览器
 ├── 主页 /（Vue SPA，现有，不动）
 └── /monitor/（新增独立静态页，零构建，nginx 直发）
        │  fetch /api/monitor/*（每 5s 摘要轮询；历史按需拉取）
        │  WebSocket /api/terminal（终端）
        ▼
nginx :80（conf.d/default.conf 与 nginx.conf 两处 server 块同步加 location）
 ├── location /monitor/        → 静态文件（root 项目目录，try_files 回退 index.html）
 ├── location /api/monitor/    → proxy_pass http://127.0.0.1:8301
 └── location /api/terminal    → 同上 + Upgrade/Connection 头（WS），read_timeout 3600s
        ▼
my-homepage-monitor.service（新增 systemd 常驻，127.0.0.1:8301，仅回环）
 ├── 采集层    本机：直读 /proc（5s）；远程：ssh2 exec 注入采集脚本（20s）
 │             └─ 可选 Agent 模式：目标机 cron 推送 /api/agent/push（扩展）
 ├── 归属引擎  /proc 四路归属 → 目录聚合（§3.3）
 ├── 存储层    内存环形（5s×1h 原始 + 1min×24h 降采样）+ JSONL 落盘（默认 7 天）
 ├── 告警引擎  阈值 × 持续窗口 → 活跃告警 + JSONL 历史 + webhook 扩展点
 ├── 终端网关  WS 鉴权 → ssh2 shell（pty）→ 双向桥接 → 审计 → 超时控制
 └── 安全      scrypt 登录 / HttpOnly 会话 / AES-256-GCM 凭据库 / 失败限速
        ▼
远程主机：10.8.14.200、47.95.140.199 …（SSH 密钥或 Agent 推送）
```

### 3.2 采集层

**本机（Agent-less，直读内核）**——全部零依赖，指标来源清单：

| 指标 | 来源 | 口径 |
|---|---|---|
| CPU 总/各核占用 | `/proc/stat`（两次采样差分） | `1 - idleΔ/totalΔ` ×100 |
| 负载 | `/proc/loadavg` | load1/5/15 + 每核归一（load/核数） |
| 内存 | `/proc/meminfo` | `used = MemTotal - MemAvailable`（含可回收缓存口径）；Swap 同理 |
| 磁盘用量 | `/proc/mounts` 过滤真实文件系统后 `fs.statfs` | 排除 proc/sysfs/tmpfs/devtmpfs/overlay/squashfs |
| 磁盘 IO | `/proc/diskstats`（物理盘差分） | 读/写 MB/s、IOPS |
| 网络 | `/proc/net/dev`（差分）+ `/proc/net/route` 定默认网卡 | 入/出 Mbps、包速率；`lo`/`veth`/`docker0` 归基础设施 |
| 进程 | 全量扫 `/proc/[0-9]*`：`stat`/`status`/`cmdline`/`io`/`cwd`(readlink)/`exe`/`fd` 目录计数 | CPU%=utime+stime 差分÷周期；RSS 取 VmRSS；线程数 status:Threads；句柄数=readdir fd 计数 |

**远程（免 Agent）**：网关通过 ssh2 `exec('sh -s')` 注入一段 POSIX sh 脚本，输出**计数器口径**单行 JSON（cpu jiffies、net 字节、diskstats 扇区、df -kP、meminfo、loadavg、uptime、以及进程清单：pid/ppid/cwd/exe/cmdline/rss/threads/utime/stime/io）。网关侧保存各主机上次计数器，**差分算速率**——注入脚本无需 sleep，单次探测 <1.5s。进程清单只保留命中跟踪目录的条目再入库（不越界采集，§5.6）。

**Agent 模式（可选扩展）**：网关提供 `GET /agent.sh`（安装脚本）与 `POST /api/agent/push`（主机 token 鉴权），目标机 crontab 每 20s 推送同构 JSON——适用于 SSH 不便（仅出站受限）或想省 SSH 开销的场景。MVP 先做 SSH 模式，接口预留。

**容器维度**：`/proc/<pid>/cgroup` 提取容器 ID（v1 `docker/<id>` / v2 路径），网关每 30s 执行一次 `docker ps --format` 缓存「容器ID → 名称/镜像/compose 工作目录（label `com.docker.compose.project.working_dir`）」，容器进程归属到 compose 项目目录或镜像名分组。本机 open-webui(:8080) 即按此归入 `docker:open-webui` 组。

### 3.3 目录归属方案（核心，需重点评审）

**发现与归属规则**（对每个进程依次尝试，任一命中即归属，按优先级）：

| 优先级 | 依据 | 覆盖场景 |
|---|---|---|
| 1 | `readlink /proc/<pid>/cwd` 命中目录树 | 常规服务（systemd/手工启动，进程在目录里运行）——**主路径** |
| 2 | `readlink /proc/<pid>/exe` 命中目录树 | 目录内编译型二进制 |
| 3 | `cmdline` 中第一个存在的、落在目录树内的文件路径 | 解释器脚本（exe=/usr/bin/node 但脚本在目录内） |
| 4 | `/proc/<pid>/cgroup` → 容器 ID → compose 工作目录 / 镜像名 | 容器化应用 |

- 内核线程（无 cwd/exe，kthreadd 后裔）直接排除；僵尸进程单列不占资源统计。
- **聚合口径**：目录占用 = 归属进程求和。CPU% 天然可加；RSS 求和存在共享页重复计数（诚实标注口径，详情页可看单进程 PSS 校准——PSS 读取较重，仅在进程详情按需读）；IO 取 `/proc/<pid>/io` 差分求和。
- **进程级网络**不做（需 eBPF，Kernel 4.19 可做但复杂度高）——以「每目录 TCP 连接数」（解析 `/proc/net/tcp` inode ↔ fd 归属）作为近似展示，列入扩展点。
- **历史趋势对比**：目录聚合值随主机序列一同写入存储（§3.4），UI 支持多目录叠加对比同一时间窗。

**默认跟踪目录 = 主页已登记应用的 `directory`**：`apps.config.json` 的 `apps[]` 已经维护了每个应用的目录（含排除项），目录跟踪自动继承，无需二次录入；用户另可在配置/界面追加任意目录（如 `/opt/something`）。**不整盘扫描**：/proc 枚举是发现进程的必要手段（与 ps 同理），但只有命中跟踪目录的进程才会**入库与留存**。

### 3.4 存储层

| 层 | 内容 | 保留 |
|---|---|---|
| 内存环形 A | 5s 原始（主机+目录聚合），~720 点 | 1 小时 |
| 内存环形 B | 1min 降采样（均值+峰值） | 24 小时 |
| JSONL 落盘 | 环形 B 每分钟追加一行/主机：`data/monitor/history/<hostId>/<YYYY-MM-DD>.jsonl` | 默认 7 天（可配 30） |
| 告警历史 | `data/monitor/alerts.jsonl` | 90 天 |
| 终端审计 | `data/monitor/audit.jsonl` | 90 天 |

数据量估算：3 主机 × 1 行/min × ~1KB ≈ **4-5MB/天**，7 天 ~35MB——JSONL 完全够用；目录聚合内嵌主机行内（dirs 数组），历史对比查询一次读文件即可。重启时回放当日 JSONL 恢复环形（丢失 <1min 数据）。

### 3.5 展示层（页面结构与下钻链路）

```
/monitor/index.html
├─ 顶栏：品牌「监控中心」│ 主机数/告警数 chip │ 返回主页 │ ⚙设置 │ 主题
├─ 主机概览（按 group 分组：内网=蓝、公网=橙，沿用主页 env 配色）
│   └─ 主机卡：状态点(CPU脉冲) · 名称/IP · uptime
│        四联仪表：CPU环 / 内存环 / 最满分区 / 网络↑↓
│        [📈 详情] [⌨ 终端]                    ← 点击卡片→详情；终端按钮→抽屉
├─ 主机详情（下钻视图）：时间窗 [1h│24h│7d] + 自动刷新开关
│   ├─ 图表网格：CPU+负载 / 内存 / 磁盘IO / 网络 / 分区用量
│   ├─ 应用资源占比：维度切换 [CPU│内存│IO读│IO写│线程│句柄] → 横向条形 Top10
│   │    └─ 点击目录条 → 进程明细表（pid/程序/目录/CPU/内存/IO/线程/句柄）
│   └─ 目录历史对比：勾选多个目录叠加同一曲线图
├─ 目录跟踪管理：已跟踪目录 chips + [＋添加目录]（§4.9）+ 每目录统计卡
├─ 告警中心：活跃告警卡（脉冲）+ 阈值配置 + 历史列表
└─ 终端抽屉（全屏右滑）+ 独立页 /monitor/terminal.html?host=<id>（可弹窗放大）
```

登录前整页仅渲染登录卡（API 全部 401，前端捕获后展示登录表单）。

### 3.6 终端网关层（时序）

```
点击 [⌨ 终端] → 前端 new WebSocket('/api/terminal?host=<id>')
  → nginx 升级 → 网关校验会话 Cookie（失败 401 拒绝升级）
  → 读取主机凭据（密钥路径 / AES-GCM 解密密码）
  → ssh2 connect+shell({pty}) → 建立「浏览器↔网关↔目标机」双向管道
  → 审计：session open（用户/主机/时间）…命令行捕获（§5.5）… close（时长/字节）
  → 超时：空闲 15min / 单会话硬顶 4h / 每主机并发上限（默认 2）
  → 断线：WS 关闭即关 SSH 通道；前端提供重连按钮
```

### 3.7 告警引擎

- 阈值模型：`{metric: cpuPct|memPct|diskPct|loadPerCore, op: >, value, sustainMin}`，默认：CPU 85% / 内存 90% / 磁盘 90%（按分区）/ 每核负载 2，持续 3 分钟；超阈值 +10 或 95% 升级为 crit。
- 状态机：pending → active（持续达窗）→ resolved（回落 + 1 个采样周期）；状态迁移写 `alerts.jsonl`。
- 通知：`webhookUrl`（POST JSON：主机/指标/值/级别/起止时间），留接飞书/钉钉/邮件 adapter 扩展点。

---

## 4. 集成实施步骤

### 4.1 依赖与目录布局（对现有哲学的影响声明）

```
新增依赖（仅网关服务用，主站前端构建仍零第三方运行时依赖）：
  ssh2@^1.17   MIT   —— SSH 采集 + 终端通道
  ws@^8.22     MIT   —— 终端 WebSocket 服务端
看板前端静态库（vendor 落库，随 git 提交）：
  echarts（白底主题自绘）、@xterm/xterm + @xterm/addon-fit

目录布局新增：
  scripts/monitor-server.mjs          # 网关（采集+API+终端+审计）
  scripts/monitor.config.json         # 监控配置（手工/界面/API 三通道）
  monitor/                            # 独立静态页（同 glass/unslop 模式，零构建）
    index.html / terminal.html / assets/{monitor.css,monitor.js,terminal.js,vendor/}
  data/monitor/                       # 运行数据（gitignore：JSONL、凭据库、密钥、初始密码）
  systemd/my-homepage-monitor.service
  docs/monitor-ops.md                 # 运维手册（部署/配置/扩缩容/排障）
```

### 4.2 网关服务关键实现点

- 单文件 `scripts/monitor-server.mjs`（零框架，http + ws + ssh2），CLI 子命令：`--set-password-stdin`、`--set-cred <hostId> --password-stdin | --keyfile <path>`、`--print-config`。
- 配置热加载：`PUT /api/monitor/config` 保存后立即生效；手工改 `monitor.config.json` 通过 fs.watch 防抖重载（与设置面板互不干扰，两套配置各管各的）。
- 端口：`127.0.0.1:8301`（仅回环，`SETTINGS_PORT` 同款思路可用 `MONITOR_PORT` 覆盖）。

### 4.3 API 清单（除 login/healthz 外全部要求会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/monitor/login` | `{password}` → HttpOnly SameSite=Strict 会话 Cookie（12h 滑动）；5 次/分失败限速 |
| GET | `/api/monitor/summary` | 全部主机最新快照 + 活跃告警 + 统计（前端 5s 轮询） |
| GET | `/api/monitor/hosts/:id/history?range=1h\|24h\|7d` | 主机序列（cpu/mem/net/disk/load） |
| GET | `/api/monitor/hosts/:id/procs?dir=` | 进程明细（目录归属、线程/句柄/IO） |
| GET | `/api/monitor/dirs/history?hosts=&dirs=&range=` | 目录维度历史（多目录叠加） |
| GET/PUT | `/api/monitor/config` | 读取（脱敏）/ 保存配置（热加载） |
| POST | `/api/monitor/hosts/:id/probe` | 立即探测一次 |
| GET | `/api/monitor/alerts?state=active\|history` / `audit?limit=` | 告警与审计查询 |
| GET | `/api/monitor/healthz` | 存活（无鉴权） |
| WS | `/api/terminal?host=<id>` | 终端通道（升级时校验会话） |

### 4.4 nginx 配置（**两处都要加**：`conf.d/default.conf` 与 `nginx.conf` 的 127.0.0.1 块）

```nginx
# 监控看板静态页（root 指向项目目录，同 glass/unslop 模式）
location /monitor/ {
    root /root/applications/my-homepage;
    try_files $uri $uri/ /monitor/index.html;
}
# 监控 API
location /api/monitor/ {
    proxy_pass http://127.0.0.1:8301;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 30s;
}
# Web 终端 WebSocket
location /api/terminal {
    proxy_pass http://127.0.0.1:8301;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

流程：先 `cp -a` 目标配置加日期后缀备份 → 修改两处 → `nginx -t` → `nginx -s reload`（遵守 AGENTS.md §10.2，勿动 paraportal 块）。

### 4.5 systemd 单元

```ini
# /etc/systemd/system/my-homepage-monitor.service
[Unit]
Description=my-homepage monitor & web-terminal gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/applications/my-homepage
ExecStart=/usr/local/bin/node /root/applications/my-homepage/scripts/monitor-server.mjs
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
```

安装：`cp systemd/my-homepage-monitor.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now my-homepage-monitor`。同步把该单元纳入 `scripts/start.sh` / `restart.sh` / `stop.sh`（现有三脚本改为管理四个单元）。

### 4.6 多机纳管操作（远程主机从零到可用）

```bash
# 1) 本机生成专用监控密钥（不与登录密钥混用）
mkdir -p data/monitor/keys && ssh-keygen -t ed25519 -f data/monitor/keys/netwatch -N '' -C my-homepage-monitor
# 2) 一次性分发公钥到目标机（此步需要输一次目标机密码，人工完成）
ssh-copy-id -i data/monitor/keys/netwatch.pub root@10.8.14.200
# 3) 看板 ⚙ 主机管理 → 添加主机：10.8.14.200 / 22 / root / 密钥认证 / data/monitor/keys/netwatch
#    （或 CLI：node scripts/monitor-server.mjs --set-cred netwatch --keyfile data/monitor/keys/netwatch）
# 4) 验证：POST /api/monitor/hosts/netwatch/probe → summary 中该主机 online:true
```

密钥文件权限 0600；密码认证为兼容项（AES-GCM 加密落 `data/monitor/credentials.json`），**推荐密钥**。

### 4.7 主站融合

- 顶栏加「监控中心」入口链接（`/monitor/`）→ 需 `./deploy.sh` 重建；看板页顶栏提供「返回主页」互链。
- 主页应用行不做深度改造（不违反「不跑题」），后续可选：应用详情里加「查看资源占用」深链 `/monitor/?dir=/root/applications/<id>`。
- 统一登录现状声明：主站本身无登录体系，看板采用**网关自带密码会话**（§5.1）；未来若上 OIDC/LDAP，网关会话层是唯一改造点。

### 4.8 目录监控规则的配置通道与生效机制（三通道等价）

1. **界面**：看板「目录跟踪管理」→ ＋添加目录（路径/显示名/备注）→ 保存即 `PUT /api/monitor/config`；
2. **配置文件**：直接编辑 `scripts/monitor.config.json` 的 `trackedDirs[]` → fs.watch 防抖热加载（≤2s 生效，无感重启）；
3. **API**：`PUT /api/monitor/config`（会话鉴权），便于自动化。

生效机制：新目录加入后**下一个采集周期（≤5s/20s）自动开始归属与留数**，历史从加入时刻起算（配置变更本身也写 `config-history` 备注，便于对比曲线时知道口径变化点）。权限边界：只允许配置**文件系统真实存在**的目录；不做通配整盘（如禁 `/` 全盘跟踪，UI 直接拒绝并提示）。

### 4.9 验收清单

```bash
systemctl status my-homepage-monitor && journalctl -u my-homepage-monitor -n 20 --no-pager
curl -s http://127.0.0.1:8301/api/monitor/healthz
curl -s -c /tmp/mh.cookie -X POST -H 'Content-Type: application/json' \
  -d "{\"password\":\"$(cat data/monitor/INITIAL_PASSWORD.txt)\"}" http://127.0.0.1/api/monitor/login
curl -s -b /tmp/mh.cookie http://127.0.0.1/api/monitor/summary | head -c 600   # 经 nginx 两处都验证
node .verify/term-test.mjs   # WS 终端自检：连本机执行 echo，断言输出
```

前端用 AGENTS.md §11.7 的 headless shell 截图验证（白底视觉、图表渲染、终端抽屉）。

---

## 5. 安全加固

### 5.1 鉴权与会话
- 密码仅存 **scrypt 哈希**（`crypto.scryptSync`，随机盐，N=16384），首启无密码时自动生成随机初始密码写 `data/monitor/INITIAL_PASSWORD.txt`（0600）并提示修改。
- 会话：32B 随机 token，HttpOnly + SameSite=Strict + Path=/；内存态（重启需重登，可接受）；写操作额外校验 `X-Requested-With` 头 + JSON Content-Type（CSRF 双保险）。
- 失败限速：5 次/分/IP → 429；健康检查 `healthz` 不泄露任何配置信息。

### 5.2 传输与网络边界
- 网关仅绑 `127.0.0.1:8301`，对外只经 nginx 80；内网 HTTP 可接受，**演进路径**：证书签发后 nginx 段升级 HTTPS + Cookie 加 `Secure`（配置项预留）。
- WS 升级请求必须携带有效会话 Cookie 且 `Origin` 与 Host 同源，否则 401 拒绝升级。

### 5.3 凭据加密存储
- 私钥：只存**文件路径**（0600），不复制私钥内容入库。
- 密码类凭据：AES-256-GCM 加密落 `data/monitor/credentials.json`；主密钥为 `data/monitor/.secret`（首启生成，0600，不入 git）。密钥丢失 → 凭据作废重录（明文永不落盘、不进日志）。

### 5.4 访问审计
- `audit.jsonl`：`{ts, event: session_open|session_close|auth_fail|config_change, host, user, durationSec, bytesIn/Out, ip}`。
- 命令捕获：记录回车提交的命令行（best-effort：对客户端→目标机字节流按 `\r` 切行；含退格修正的近似处理），**不开全键盘流记录**（避免记录密码输入等敏感内容，只需在审计中能还原「执行过什么命令」的合理近似）。
- 管理动作（改配置/改凭据/登录失败）全部入审计。

### 5.5 命令白名单——诚实的能力边界
全交互 PTY 终端无法可靠做命令白名单（`vim:!`、反引号、脚本粘贴均可绕过，宣称白名单是虚假安全）。我们的分层策略：
1. **默认**：完整交互终端 + 审计 + 空闲 15min / 硬顶 4h / 并发上限；
2. **目标机侧加固**（真正有效的白名单位置）：目标机用专用账号 + `sudo` 白名单 / `rbash` / iptables 限源；
3. **扩展点**：网关「受限命令面板」模式（仅放行预定义命令按钮，非 PTY，逐条 exec）——列入 §8。

### 5.6 采集边界（不越权）
- 只跟踪显式配置的目录；/proc 全量枚举仅用于归属判定（与 `ps` 等价），未命中目录的进程**不入库、不留存、不出现在任何接口**。
- 远程探测脚本只读（`cat`/`readlink`/`df`），绝不执行写操作；SSH 采用 `BatchMode`，禁用 agent 转发。

---

## 6. 前端视觉与动效方案（白底基调）

### 6.1 设计基调
- **白底为主**：页面底 `--bg #f6f7f9`，卡片 `--bg-soft #ffffff`；全套变量直接沿用 `src/style.css` 浅色主题（`--accent #2563eb` 主蓝、`--green/--red/--amber` 状态色、`--border/--shadow` 层级）——与主页 zero 认知成本互通。
- 沿用主页语义色：**内网蓝 / 公网橙**（env 分组与卡片边条）、运行绿/告警红；深色主题作为可选项（`html[data-theme=dark]` 同套变量切换），**默认浅色**。
- 字体/圆角/阴影间距与主页一致（15px 正文、`--mono` 用于数字列，`font-variant-numeric: tabular-nums` 防跳动抖版）。

### 6.2 动效清单（每条：效果 → 实现 → 参数 → 性能约束）

| # | 效果 | 实现 | 参数 | 约束 |
|---|---|---|---|---|
| 1 | 指标数字滚动 | rAF 对新旧值插值 | 250ms `easeOutCubic`；仅文本节点 | 离屏暂停；`tabular-nums` 防抖版 |
| 2 | 卡片悬停抬升 | CSS `transform + box-shadow` 过渡 | 160ms `cubic-bezier(.2,.8,.2,1)` | 只动合成层属性 |
| 3 | 告警状态点脉冲 | CSS keyframes（box-shadow 扩散） | 2s `ease-in-out` infinite，仅 active 告警 | `prefers-reduced-motion: reduce` 时停用 |
| 4 | 图表曲线 | ECharts：`smooth: 0.3` + `areaStyle` 线性渐变（主题色 α0.22→0）+ `animationDurationUpdate: 300, animationEasingUpdate: 'cubicOut'` | 初次 400ms 入场 | 更新走 setOption 增量，不销毁重建 |
| 5 | 分区入场 | CSS `fadeUp` stagger | 60ms 间隔、320ms、仅首次 | 更新/轮询**不重播**（`state.entered` 标记，吸取 glass 踩坑 #6 教训） |
| 6 | 骨架屏 | CSS shimmer（渐变位移） | 仅首次加载 | 数据到达即替换 |
| 7 | 顶栏标题渐变扫光 | `background-clip: text` 渐变位移动画 | 1.2s，仅加载一次 | 装饰性，reduced-motion 关闭 |
| 8 | 网络流向感 | 网络图表 in/out 双向渐变面积 + 图例同步高亮 | — | 不做粒子流（避免视觉干扰，遵循「不炫技过度」） |

**性能红线**：轮询 5s 一次只做 `setOption` 增量与文本更新；`visibilitychange` 离开页面暂停轮询与 rAF；图表容器 `will-change` 不滥用；动效仅 transform/opacity/box-shadow；全部动效包裹在 `@media (prefers-reduced-motion: no-preference)` 内。

### 6.3 图表主题（ECharts init 参数与色板）
- 白底透明背景；坐标轴线/分割线 `#e4e7ec` 虚线；文字 `--text-2`；
- 色板按语义：CPU `--accent`、内存 `--purple`、磁盘 IO 读 `--teal`/写 `--amber`、网络入 `--accent`/出 `--green`、告警线 `--red`；目录条形图 Top10 用单色渐变（避免彩虹条）；
- tooltip：`axisPointer: {type:'shadow'}` + 阴影背景 `rgba(37,99,235,0.06)`。

---

## 7. 运维文档（部署 / 配置 / 扩缩容 / 排障）

完整版随实施落 `docs/monitor-ops.md`，骨架：
- **部署**：§4.4-4.6 全量命令序列 + 一键脚本（`scripts/monitor-install.sh`）；
- **配置**：`monitor.config.json` 全字段 schema 注释表 + 常改项（采集间隔/保留天数/阈值/主机）；
- **扩缩容**：主机扩容=加密钥+加条目（无状态网关，横向无锁）；数据扩容=保留天数调 30 天（估算 ~150MB）；接 Prometheus=`/metrics` 双写（§8）；
- **排障**：表驱动（现象→检查点→命令）：主机 offline（`journalctl` / 手动 probe / ssh -v 复现）、终端打不开（WS 升级头 / 会话过期 / 目标机 sshd）、图表空（JSONL 回放 / 时区）、`/api/monitor` 502（网关死了→systemd）、504（SSH 卡→超时参数）。

---

## 8. 可扩展点（预留，不在本期实现）

| 扩展 | 接口预留 |
|---|---|
| Prometheus 长期存储 | 网关 `GET /metrics`（文本格式），Prometheus 抓取或 remote_write，前端历史查询层抽象 provider |
| 告警通知渠道 | webhook payload 固定 schema；飞书/邮件 adapter |
| 终端录屏 | 审计字节流落 asciicast 格式，回放页 |
| 受限命令面板 | 网关 exec 模式（非 PTY），命令白名单真正可执行的位置 |
| 自定义目录规则 API | `trackedDirs[]` 支持通配 + 排除子目录（当前仅精确路径） |
| 进程级网络 | eBPF（Kernel 4.19 可行）/ ss -tnp 连接数近似（轻量，优先） |
| OIDC 统一登录 | 网关会话层替换为 OIDC 回调 |

---

## 9. 风险与诚实声明

1. 自研=自维护：监控深度（如任意长回溯、复杂告警规则）不如专业栈，已用扩展点兜底；代码量约 2500 行（网关 ~1100 / 前端 ~1400），与现有 probe/settings 同风格。
2. 远程主机 10.8.14.200 与 47.95.140.199 的 SSH 密钥分发需**人工输一次密码**（`ssh-copy-id`），自动化无法替代；在此之前两台主机在看板中显示「待配置凭据」。
3. 共享内存口径：目录内存=RSS 求和含共享页重复计数（展示侧标注）；精确对比用进程详情 PSS。
4. 内网 HTTP 下终端流量未加密（SSH 本身加密终端内容，浏览器↔nginx 段为明文 WS）——内网可接受，公网暴露前必须上 TLS（§5.2）。
