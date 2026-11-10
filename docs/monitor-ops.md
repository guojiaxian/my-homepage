# 监控中心与 Web 终端 · 运维手册

> 配套设计文档：`docs/monitor-terminal-blueprint.md`（选型对比 / 架构 / 安全设计）
> 本文面向日常运维：部署、配置、扩缩容、排障。
> 入口：主页 `http://<本机IP>/` 顶栏「我的应用 / 监控中心」标题切换（`#monitor` 直达）；`/monitor/` 仅保留旧链接重定向与终端弹窗页（`/monitor/terminal.html?host=<id>`）。API 仅回环 8301，对外一律经 nginx。

---

## 1. 部署（全新机器从零到可用）

```bash
cd /root/applications/my-homepage

# 1) 依赖（网关运行需要 ssh2/ws；echarts/xterm 仅用于 vendor 拷贝，已在仓库中）
npm install

# 2) systemd 单元
cp systemd/my-homepage-monitor.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now my-homepage-monitor.service

# 3) nginx（两处 server 块都已有 /monitor/、/api/monitor/、/api/terminal location；
#    全新机器需按 docs/monitor-terminal-blueprint.md §4.4 手工添加）
nginx -t && nginx -s reload

# 4) 首次登录密码（首启自动生成，文件仅 root 可读）
cat data/monitor/INITIAL_PASSWORD.txt
# 登录后 → ⚙ 设置 → 修改访问密码（改完可删除该文件）
```

纳入 `./scripts/start.sh | restart.sh | stop.sh` 统一管理（已更新为四个单元）。

## 2. 配置速查（`scripts/monitor.config.json`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | 8301 | 网关监听端口，**仅绑 127.0.0.1**；改后需同步 nginx `proxy_pass` |
| `auth.sessionTtlHours` | 8760（=1 年） | 会话滑动时长；会话持久化在 `data/monitor/sessions.json`（网关重启不掉线），同浏览器登录一次即长期免密。密码哈希在 `data/monitor/.password-hash`（0600），无复杂度规则，`--set-password-stdin` 自动更新 |
| `collect.localIntervalSec` | 5 | 本机采集周期 |
| `collect.remoteIntervalSec` | 20 | 远程 SSH 采集周期 |
| `collect.retentionDays` | 7 | 历史 JSONL 保留天数（7 天约 35MB/3 主机） |
| `thresholds.*` | CPU 85 / 内存 90 / 磁盘 90 / 每核负载 2 | 告警阈值；`sustainMin` 持续分钟才触发 |
| `terminal.*` | 空闲 15 分 / 上限 240 分 / 并发 2 | Web 终端限制；`recordCommands` 命令审计开关 |
| `webhookUrl` | 空 | 告警触发/恢复时 POST JSON |
| `hosts[]` | 本机 + 2 远程 | 纳管主机；`type: local` 直读 /proc，`type: ssh` 免 Agent 采集 |
| `trackedDirs[]` | 空 | 自定义跟踪目录；**主页 `apps[].directory` 自动并入，无需重复登记** |

三种修改通道（等价）：看板 ⚙ 设置界面 / 直接改配置文件（≤2s 热加载）/ `PUT /api/monitor/config`。
每次界面保存自动备份 `monitor.config.json.bak`。

## 3. 远程主机纳管

```bash
# 1) 本机已有专用密钥对：data/monitor/keys/<hostId>(.pub)
# 2) 一次性分发公钥（需输一次目标机密码，人工完成）
ssh-copy-id -i data/monitor/keys/netwatch.pub root@10.8.14.200
ssh-copy-id -i data/monitor/keys/aliyun.pub  root@47.95.140.199
# 3) 无需重启：下一个采集周期（≤20s）主机自动转 ONLINE
# 密码认证（不推荐，兼容项）：
echo '目标机密码' | node scripts/monitor-server.mjs --set-cred <hostId> --password-stdin
```

- 密钥文件权限必须 0600（已设）；`credentials.json`（AES-256-GCM）存密码凭据与主机指纹（TOFU 防中间人，指纹变化会拒绝连接，确认合法后删除该主机 `hostFp` 字段重连）。
- 非 root 用户采集时 IO/句柄字段为空（`/proc/<pid>/io` 需 root），其余指标正常。

## 4. 目录跟踪

### 4.1 采集方式：SSH 拉取 vs Agent 推送（2026-11-10）

| | SSH 拉取（默认） | Agent 推送 |
|---|---|---|
| 连接 | 中心每 20s SSH 短连接 exec 采集 | 目标机 agent 每 20s curl POST 到中心 |
| 前置 | 密钥/凭据 | 一条安装命令（自带 token） |
| 适用 | 全部（含公网机，中心主动外连） | 内网可达中心的机器 |
| 监控期 SSH 连接 | 每周期一次短连接 | **零**（SSH 仅用于终端） |
| 掉线判定 | 探测失败 | 推送断流 >70s（看门狗） |

**自动纳管（推荐，零手工）**：⚙ 监控设置 → 添加/编辑主机 → 填地址、用户名 → 「自动部署」区输入**目标机密码** → 点「自动安装 Agent 并配置免密」。中心自动完成：写入免密公钥 → 安装并启动 agent → 免密复验 → 切 agent 模式 → 密码加密存档（备用）。弹窗内逐步显示 6 步日志；实测约 1 秒。亦可走 API：

```bash
curl -X POST http://127.0.0.1/api/monitor/hosts/provision \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' -b cookie \
  -d '{"host":{"id":"node1","name":"节点1","type":"ssh","group":"内网","address":"10.8.11.9","port":22,"username":"root"},"password":"***"}'
```

手工安装（目标机 root 执行；设置页主机弹窗「采集方式=Agent 推送」可生成/复制，或 CLI）：

```bash
node scripts/monitor-server.mjs --agent-install-cmd <hostId>   # 打印命令
curl -fsSL 'http://10.8.11.4/api/monitor/agent/install.sh?token=<token>&interval=20' | sh
```

安装动作：写 `/usr/local/bin/my-homepage-agent.sh`（0700，含 token）+ systemd 单元 `my-homepage-agent.service`（enable --now；无 systemd 兜底 nohup+cron）——**幂等可重装，不触碰目标机其它服务**。卸载：`systemctl disable --now my-homepage-agent && rm -f /etc/systemd/system/my-homepage-agent.service /usr/local/bin/my-homepage-agent.sh`。公网机（无法内连中心，如阿里云）保持 SSH 拉取模式。

- **归属规则**：cwd → exe → cmdline → cgroup(容器 compose 工作目录) 四路匹配；未命中进程不入库。
- **新增目录**：设置界面「＋添加目录」；或配置文件 `trackedDirs[]`；生效 ≤5s（本机）/≤20s（远程），历史从加入时刻起算。
- **边界**：拒绝 `/` 全盘跟踪；容器按 compose 工作目录归组，无 compose 信息的按 `容器 <name>` 单列。

## 5. 扩缩容

| 场景 | 操作 |
|---|---|
| 加主机 | 设置界面添加 + 分发密钥（无状态网关，无锁无迁移） |
| 历史延长 | `collect.retentionDays` 调 30（约 150MB/3 主机）；再长建议接 Prometheus（网关可加 `/metrics` 双写，见蓝图 §8） |
| 采集降压 | 调大 `localIntervalSec`/`remoteIntervalSec`；远程探测为单次 exec <1.5s，20s 周期对目标机负载可忽略 |
| 网关内存 | 实测 ~35MB 常驻；环形数据上限约 hosts×(720+1440) 点，内存占用 <20MB |

## 6. 排障（现象 → 检查 → 处置）

| 现象 | 检查 | 处置 |
|---|---|---|
| `/api/monitor/*` 502 | `systemctl status my-homepage-monitor` | 网关没起来：`journalctl -u my-homepage-monitor -n 50`；起后自愈 |
| 主机卡片「未连通: All configured authentication methods failed」 | 密钥是否已 `ssh-copy-id`；`ssh -i <keyPath> root@host true` 手测 | 分发公钥；或确认 `keyPath` 指向**已在目标机 authorized_keys 里的**私钥（本机默认终端走 `~/.ssh/id_rsa`，id_ed25519 不在 authorized_keys） |
| 主机指纹告警拒绝连接 | 目标机是否重装/换 IP 复用 | 确认合法后删 `data/monitor/credentials.json` 中该主机 `hostFp` |
| 终端打不开（立刻断开 401） | 会话是否丢失（cookie 被清理 / 换了浏览器） | 重新登录一次即可（会话持久化在网关侧，重启不掉线）；浏览器 WS 被代理拦截时检查 nginx `/api/terminal` 的 Upgrade 头（两处 server 块都要有） |
| 终端「该主机并发会话已达上限」 | `maxSessionsPerHost`（默认 2） | 关闭闲置会话或在设置中调大 |
| 图表空白 | 该主机是否刚启用（首个周期前无速率数据） | 等一个周期；`curl -b cookie .../hosts/<id>/history?range=1h` 看点数 |
| 告警不触发 | `sustainMin` 持续窗口未到 | 默认持续 3 分钟才触发，属预期 |
| 忘记密码 | — | `echo '新密码' \| node scripts/monitor-server.mjs --set-password-stdin` |
| `.secret` 丢失 | — | 密码凭据解不开：重新 `--set-cred` 录入；密钥认证不受影响 |

数据/日志位置：

```
data/monitor/history/<hostId>/<日期>.jsonl   # 分钟级历史（含目录聚合）
data/monitor/alerts.jsonl                    # 告警触发/恢复
data/monitor/audit.jsonl                     # 会话/鉴权/配置变更审计（含命令捕获）
```

## 7. 安全要点（变更前必读）

- 8301 仅回环；**不要**改成 0.0.0.0 对外。
- 密码只存 scrypt 哈希；改密后全部会话失效。写操作需 `X-Requested-With` 头（CSRF 双保险）+ 登录限速 5 次/分。
- 内网当前为 HTTP：终端内容本身经 SSH 加密，浏览器↔nginx 段为明文 WS；**公网暴露前必须上 TLS**（nginx 证书 + Cookie `Secure`）。
- 全交互 PTY 无法可靠做命令白名单（设计文档 §5.5），现有约束 = 会话审计 + 空闲/时长/并发上限；更强约束在目标机侧做（专用账号 + sudo 白名单）。
