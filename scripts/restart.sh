#!/usr/bin/env bash
# 手动重启：重启「设置 API」与「探测定时器」，并立即跑一次探测。
# 不改变开机自启状态：
#   · 正常状态（enabled）→ 重启后仍随开机自启
#   · 曾执行过 stop.sh（disabled）→ 本次仅临时运行，重启服务器后不会自启
#     需要恢复自启请执行 ./scripts/start.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd -P)"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[警告]\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "需要 root 权限：sudo $0" >&2; exit 1; }

was_enabled="$(systemctl is-enabled my-homepage-settings.service 2>/dev/null || true)"

say "重启设置 API"
systemctl restart my-homepage-settings.service

say "重启探测定时器"
systemctl restart my-homepage-probe.timer

say "立即探测一次（--no-fetch，约 1~2 秒）"
node "$PROJECT_DIR/scripts/probe-apps.mjs" --no-fetch \
  || warn "探测失败，定时器稍后会重试：journalctl -u my-homepage-probe -n 30"

echo
say "状态"
printf '  %-34s %s / %s\n' my-homepage-settings.service "$(systemctl is-active my-homepage-settings.service)" "$(systemctl is-enabled my-homepage-settings.service 2>&1)"
printf '  %-34s %s / %s\n' my-homepage-probe.timer "$(systemctl is-active my-homepage-probe.timer)" "$(systemctl is-enabled my-homepage-probe.timer 2>&1)"

if [[ "$was_enabled" != "enabled" ]]; then
  echo
  warn "当前处于「永久关闭」状态（disabled）：本次仅临时运行，服务器重启后不会自启。恢复：./scripts/start.sh"
fi

curl -s -o /dev/null -w "  主页 → HTTP %{http_code}\n" http://127.0.0.1/ || true
curl -s -o /dev/null -w "  设置 API → HTTP %{http_code}\n" http://127.0.0.1/api/config || true
