#!/usr/bin/env bash
# 手动停止：停止「设置 API」与「探测定时器」，并**取消开机自启**（永久关闭）。
# 重启服务器后不会自动拉起；恢复请执行 ./scripts/start.sh。
#
# 说明：主页是静态文件，由共享的 nginx（80 端口）托管，且同一 nginx 还承载
# 其他历史代理路径，因此本脚本不动 nginx——停的是本项目自己的后台服务：
#   · my-homepage-settings  首页设置面板的读写 API
#   · my-homepage-probe     端口/运行状态/git 同步的定时探测
# 停止后页面仍可打开，但数据不再更新、设置面板保存会失败。
set -euo pipefail

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[警告]\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "需要 root 权限：sudo $0" >&2; exit 1; }

say "停止定时器并取消开机自启"
systemctl disable --now my-homepage-probe.timer

say "停止设置 API 并取消开机自启"
systemctl disable --now my-homepage-settings.service

# 若探测正好在跑（oneshot），一并停掉
systemctl stop my-homepage-probe.service 2>/dev/null || true

echo
say "状态"
printf '  %-34s %s / %s\n' my-homepage-settings.service "$(systemctl is-active my-homepage-settings.service)" "$(systemctl is-enabled my-homepage-settings.service 2>&1)"
printf '  %-34s %s / %s\n' my-homepage-probe.timer "$(systemctl is-active my-homepage-probe.timer)" "$(systemctl is-enabled my-homepage-probe.timer 2>&1)"

echo
warn "已永久关闭：重启服务器后不会自动启动。恢复请执行 ./scripts/start.sh"
echo "  静态页面仍由 nginx 提供（共享 80 端口，不影响其他站点），但数据不再更新、设置面板不可用。"
