#!/usr/bin/env bash
# 一键发布：构建前端 → 探测端口 → 同步到 webroot → 校验并重载 nginx
set -euo pipefail

cd "$(dirname "$0")"

WEBROOT="/root/applications/my-homepage/www"

echo "==> 1/4 运行端口探测（生成 apps.json，先于构建以保证 dist 内副本为最新）"
node scripts/probe-apps.mjs

echo "==> 2/4 构建前端"
npm run build

echo "==> 3/4 同步到 ${WEBROOT}"
mkdir -p "$WEBROOT"
rsync -a --delete dist/ "$WEBROOT"/
chmod 644 "$WEBROOT"/apps.json 2>/dev/null || true

echo "==> 4/4 校验并重载 nginx"
nginx -t
nginx -s reload

echo "==> 完成：http://0.0.0.0:80（curl http://127.0.0.1/ 验证）"
