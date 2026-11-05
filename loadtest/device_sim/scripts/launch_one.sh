#!/bin/bash
# run.sh から呼ばれる: 1 か所分のシミュレータ（コンテナ）を起動する。引数: NN
set -euo pipefail
n=$1
HERE=$(cd "$(dirname "$0")" && pwd)
PKG=$(cd "$HERE/.." && pwd)
docker run -d --name "devsim-$n" \
  -e URL="$URL" -e SITE="ld$n" -e INDEX="$((10#$n))" -e TOTAL="$SITES" \
  -e MODE="$MODE" -e BATCH_SECONDS="${BATCH_SECONDS:-60}" -e DURATION="$DURATION" \
  -e LOG_FILE="/logs/sim-ld$n.log" -e PYTHONPATH=/app \
  -v "$PKG:/app/device_sim:ro" -v "$KEYS_DIR/key-$n:/key:ro" -v "$LOGS_DIR:/logs" \
  python:3.12-slim python -u -m device_sim > /dev/null
