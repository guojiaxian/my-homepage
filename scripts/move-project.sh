#!/usr/bin/env bash
# 项目目录迁移：把本项目整体搬到新目录，并修正所有绝对路径引用。
#
# 用法：
#   ./scripts/move-project.sh /opt/my-homepage
#   ./scripts/move-project.sh /opt/my-homepage --webroot /opt/www/my-homepage
#   ./scripts/move-project.sh /opt/my-homepage --dry-run     # 只打印计划，不动任何东西
#
# 处理内容：
#   1. 暂停探测定时器与设置服务（期间主页仍可访问，只是数据暂不刷新）
#   2. 迁移项目目录（同一文件系统为瞬时 rename）
#   3. 重写 systemd/*.service 的 ExecStart 并重装到 /etc/systemd/system
#   4. 可选 --webroot：迁移部署产物目录，并同步改造 deploy.sh、probe-apps.mjs
#      的输出路径、两处 nginx 配置的 root
#   5. 更新 AGENTS.md / README.md / .verify 脚本中记录的项目路径
#   6. 重载 systemd / nginx，跑一次探测，验证页面与设置 API，恢复服务
#
# 幂等：本脚本可在任意路径重复运行；要搬回去，就再执行一次并传入原路径。
set -euo pipefail

# ---------- 输出helpers ----------
say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[警告]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

DRY_RUN=0
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '    \033[2m[dry-run]\033[0m %s\n' "$*"
  else
    "$@"
  fi
}

# ---------- 参数解析 ----------
TARGET_ARG=""
NEW_WEBROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --webroot)
      [[ $# -ge 2 ]] || die "--webroot 需要一个路径参数"
      NEW_WEBROOT="$2"; shift 2 ;;
    -h|--help)
      head -24 "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) die "未知参数：$1" ;;
    *) [[ -z "$TARGET_ARG" ]] || die "只能指定一个目标目录"; TARGET_ARG="$1"; shift ;;
  esac
done
[[ -n "$TARGET_ARG" ]] || die "用法：$0 <目标目录> [--webroot <新部署目录>] [--dry-run]"
[[ $EUID -eq 0 ]] || die "需要 root 权限（要改 systemd 单元与 nginx 配置）"

# ---------- 计算源与目标 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$(cd "$SCRIPT_DIR/.." && pwd -P)"
TARGET="$(realpath -m "$TARGET_ARG")"
# 当前部署目录从 deploy.sh 读取，避免写死（项目可能已被迁移过）
OLD_WEBROOT="$(sed -n 's/^WEBROOT="\(.*\)"$/\1/p' "$SOURCE/deploy.sh" 2>/dev/null | head -1)"
OLD_WEBROOT="${OLD_WEBROOT:-/var/www/my-homepage}"
[[ -n "$NEW_WEBROOT" ]] && NEW_WEBROOT="$(realpath -m "$NEW_WEBROOT")"

[[ "$TARGET" != "$SOURCE" ]] || die "目标目录与当前目录相同：$TARGET"
# 不允许互相嵌套（会造成 mv 递归 / 丢失）
case "$TARGET/" in "$SOURCE"/*) die "目标目录不能位于项目内部：$TARGET" ;; esac
case "$SOURCE/" in "$TARGET"/*) die "项目不能迁移到自己的上级路径：$TARGET" ;; esac

if [[ -e "$TARGET" ]]; then
  [[ -d "$TARGET" ]] || die "目标已存在且不是目录：$TARGET"
  [[ -z "$(ls -A "$TARGET" 2>/dev/null)" ]] || die "目标目录非空：$TARGET"
fi

if [[ -n "$NEW_WEBROOT" ]]; then
  [[ "$NEW_WEBROOT" != "$OLD_WEBROOT" ]] || die "--webroot 与当前部署目录相同，无需指定"
  if [[ -e "$NEW_WEBROOT" ]]; then
    [[ -d "$NEW_WEBROOT" && -z "$(ls -A "$NEW_WEBROOT" 2>/dev/null)" ]] \
      || die "新部署目录已存在且非空：$NEW_WEBROOT"
  fi
fi

# ---------- 打印计划 ----------
cat <<EOF

  项目目录：  $SOURCE
           →  $TARGET
  部署目录：  $OLD_WEBROOT
           →  ${NEW_WEBROOT:-（保持不变）}
  涉及的绝对路径引用：
    · $TARGET/systemd/my-homepage-{probe,settings}.service  (ExecStart)
    · /etc/systemd/system/my-homepage-{probe,settings}.service
    · AGENTS.md / README.md / .verify/*.cjs 中的路径说明
$( [[ -n "$NEW_WEBROOT" ]] && printf '    · %s/deploy.sh、scripts/probe-apps.mjs（输出路径）\n    · /etc/nginx/conf.d/default.conf、/etc/nginx/nginx.conf（root）\n' "$TARGET" )
  迁移期间主页约 3~10 秒不可用（服务重启），随后自动恢复。

EOF
if [[ $DRY_RUN -eq 1 ]]; then warn "dry-run 模式：以下只打印不执行"; fi

cd /   # 避免脚本自身目录被移动后 cwd 失效

# ---------- 1. 暂停服务 ----------
say "1/7 暂停探测定时器与设置服务"
run systemctl stop my-homepage-probe.timer || true
run systemctl stop my-homepage-probe.service 2>/dev/null || true
run systemctl stop my-homepage-settings.service 2>/dev/null || true

# ---------- 2. 迁移项目目录 ----------
say "2/7 迁移项目目录"
run mkdir -p "$(dirname "$TARGET")"
if [[ -d "$TARGET" && -z "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
  run rmdir "$TARGET"
fi
run mv "$SOURCE" "$TARGET"

# ---------- 3. 重写 systemd 单元 ----------
say "3/7 更新 systemd 单元路径"
for unit in my-homepage-probe.service my-homepage-settings.service; do
  f="$TARGET/systemd/$unit"
  [[ $DRY_RUN -eq 1 || -f "$f" ]] || die "缺少单元文件：$f"
  run sed -i "s|$SOURCE|$TARGET|g" "$f"
  run cp -f "$f" "${f}.bak"
  run cp -f "$f" "/etc/systemd/system/$unit"
done
run cp -f "$TARGET/systemd/my-homepage-probe.timer" /etc/systemd/system/
run systemctl daemon-reload

# ---------- 4. 可选：迁移部署目录 ----------
if [[ -n "$NEW_WEBROOT" ]]; then
  say "4/7 迁移部署产物目录"
  run mkdir -p "$(dirname "$NEW_WEBROOT")"
  if [[ -d "$NEW_WEBROOT" && -z "$(ls -A "$NEW_WEBROOT" 2>/dev/null)" ]]; then
    run rmdir "$NEW_WEBROOT"
  fi
  if [[ -d "$OLD_WEBROOT" ]]; then
    run mv "$OLD_WEBROOT" "$NEW_WEBROOT"
  else
    run mkdir -p "$NEW_WEBROOT"
  fi

  # deploy.sh 的 WEBROOT
  run sed -i "s|$OLD_WEBROOT|$NEW_WEBROOT|g" "$TARGET/deploy.sh"
  # 探测器写出的线上 apps.json 路径
  run sed -i "s|$OLD_WEBROOT|$NEW_WEBROOT|g" "$TARGET/scripts/probe-apps.mjs"

  # 两处 nginx 配置的 root（先备份再改）
  ts="$(date +%Y%m%d%H%M%S)"
  for conf in /etc/nginx/conf.d/default.conf /etc/nginx/nginx.conf; do
    [[ -f "$conf" ]] || continue
    run cp -f "$conf" "${conf}.bak-${ts}"
    run sed -i "s|$OLD_WEBROOT|$NEW_WEBROOT|g" "$conf"
  done
  run nginx -t
  run nginx -s reload
else
  say "4/7 部署目录保持不变（$OLD_WEBROOT）"
fi

# ---------- 5. 更新文档中的路径 ----------
say "5/7 更新文档中的项目路径"
for f in "$TARGET/AGENTS.md" "$TARGET/README.md"; do
  [[ -f "$f" ]] && run sed -i "s|$SOURCE|$TARGET|g" "$f"
done
# 开发期验证脚本里的截图输出路径
if [[ -d "$TARGET/.verify" ]]; then
  while IFS= read -r -d '' f; do
    run sed -i "s|$SOURCE|$TARGET|g" "$f"
  done < <(find "$TARGET/.verify" -maxdepth 1 -type f -name '*.cjs' -print0 2>/dev/null)
fi

# ---------- 6. 跑一次探测生成 apps.json ----------
say "6/7 运行一次探测（--no-fetch）"
run node "$TARGET/scripts/probe-apps.mjs" --no-fetch || warn "探测未成功，请手动执行：node $TARGET/scripts/probe-apps.mjs"

# ---------- 7. 恢复服务并验证 ----------
say "7/7 恢复服务并验证"
run systemctl daemon-reload
run systemctl enable --now my-homepage-probe.timer
run systemctl restart my-homepage-settings.service
sleep 1

if [[ $DRY_RUN -eq 0 ]]; then
  page_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/ || echo 000)"
  api_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/config || echo 000)"
  [[ "$page_code" == "200" ]] || warn "主页返回 $page_code，请检查 nginx：nginx -t && systemctl status nginx"
  [[ "$api_code" == "200" ]]  || warn "设置 API 返回 $api_code，请检查：systemctl status my-homepage-settings"

  echo
  say "迁移完成"
  cat <<EOF
  项目目录：$TARGET
  部署目录：${NEW_WEBROOT:-$OLD_WEBROOT}
  主页：   http://10.8.11.4/  （HTTP $page_code）
  设置API：/api/config       （HTTP $api_code）
  服务：
    systemctl status my-homepage-settings
    systemctl list-timers my-homepage-probe.timer

  后续操作都在新目录进行：
    cd $TARGET && ./deploy.sh
  如需回滚（搬回原处）：
    $TARGET/scripts/move-project.sh $SOURCE
EOF
else
  say "dry-run 结束（未做任何改动）"
fi
