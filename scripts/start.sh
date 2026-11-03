#!/usr/bin/env bash
# 手动启动：启用开机自启并立即启动「设置 API」与「探测定时器」，随后跑一次探测。
# 与 stop.sh 对应：stop.sh 会取消开机自启（永久关闭），本脚本会恢复。
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd -P)"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[警告]\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "需要 root 权限：sudo $0" >&2; exit 1; }

say "启用并启动（开机自启）"
systemctl daemon-reload
systemctl enable --now my-homepage-settings.service
systemctl enable --now my-homepage-probe.timer
systemctl enable --now my-homepage-probe-quick.timer

say "立即探测一次（--no-fetch，约 0.3 秒）"
node "$PROJECT_DIR/scripts/probe-apps.mjs" --no-fetch \
  || warn "探测失败，定时器稍后会重试：journalctl -u my-homepage-probe -n 30"

if ! systemctl is-active --quiet nginx; then
  warn "nginx 未运行，主页无法访问：systemctl start nginx"
fi

echo
say "状态"
printf '  %-34s %s / %s\n' my-homepage-settings.service "$(systemctl is-active my-homepage-settings.service)" "$(systemctl is-enabled my-homepage-settings.service 2>&1)"
printf '  %-34s %s / %s\n' my-homepage-probe.timer "$(systemctl is-active my-homepage-probe.timer)" "$(systemctl is-enabled my-homepage-probe.timer 2>&1)"
printf '  %-34s %s / %s\n' my-homepage-probe-quick.timer "$(systemctl is-active my-homepage-probe-quick.timer)" "$(systemctl is-enabled my-homepage-probe-quick.timer 2>&1)"
printf '  %-34s %s / %s\n' nginx.service "$(systemctl is-active nginx.service)" "$(systemctl is-enabled nginx.service 2>&1)"

echo
say "检查可访问性"
curl -s -o /dev/null -w "  主页 http://<本机IP>/        → HTTP %{http_code}\n" http://127.0.0.1/ || true
curl -s -o /dev/null -w "  设置 API /api/config        → HTTP %{http_code}\n" http://127.0.0.1/api/config || true
