#!/bin/bash
# 双击即可：启动本地服务（含开奖数据同源代理）并自动打开页面。
# 页面加载时会自动核对官方最新开奖并补齐，无需手动更新数据。
cd "$(dirname "$0")" || exit 1

PORT=8000
LOG=$(mktemp)
python3 scripts/serve.py "$PORT" > "$LOG" 2>&1 &
PID=$!

# 从服务输出里取真实端口（8000 被占用时会自动顺延）
URL=""
for _ in $(seq 1 30); do
  URL=$(grep -o 'http://localhost:[0-9]*/index.html' "$LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 0.3
done
open "${URL:-http://localhost:$PORT/index.html}"

trap 'kill $PID 2>/dev/null; rm -f "$LOG"' EXIT
wait $PID
