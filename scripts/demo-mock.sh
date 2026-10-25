#!/usr/bin/env bash
# FQRH v4 演示：假上游(8899) + 网关(8790)，Ctrl+C 一起退出
set -euo pipefail

cd "$(dirname "$0")/.."

node src/mock-upstream.mjs --port 8899 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

sleep 1
echo "[FQRH] 假上游已起（8899）；网关用 config.demo.json 起在 8790"
echo "[FQRH] 面板: http://127.0.0.1:8790/__admin/dashboard   客户端 key: sk-fqrh-demo"
node src/server.mjs --config config.demo.json "$@"
