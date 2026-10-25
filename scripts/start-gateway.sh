#!/usr/bin/env bash
# FQRH v4 前台启动（开发 / 临时用）
# 生产环境请用 systemd：sudo bash scripts/install-linux.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f config.json ]; then
  echo "[FQRH] 没有 config.json，已从 config.example.json 复制；记得改 providers / clientKeys 后再用"
  cp config.example.json config.json
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[FQRH] 找不到 node，请先安装 Node.js 24（或 22.5+）" >&2
  exit 1
fi

exec node src/server.mjs --config config.json "$@"
