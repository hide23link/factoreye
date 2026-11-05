#!/bin/bash
# シミュレータを起動する（1 か所 = 1 コンテナ）。
#   使い方: run.sh <か所の数> <MODE: second|batch> <秒数> <取り込みの URL>
#   例:     run.sh 100 batch 3600 http://192.0.2.10:8001/api/ingest/readings
#   環境変数: KEYS_DIR（既定 ./keys）、LOGS_DIR（既定 ./logs）、BATCH_SECONDS（既定 60）
#   前提: setup_devices.sh を済ませてある。Mac の Docker だと、Mac がスリープしないよう caffeinate を併用する
set -euo pipefail
export SITES=${1:?か所の数} MODE=${2:?second か batch} DURATION=${3:?秒数} URL=${4:?取り込みの URL}
export KEYS_DIR=$(cd "${KEYS_DIR:-./keys}" && pwd)
mkdir -p "${LOGS_DIR:-./logs}"
export LOGS_DIR=$(cd "${LOGS_DIR:-./logs}" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
for n in $(seq 1 "$SITES"); do printf "%02d\n" "$n"; done | xargs -P 25 -I{} "$HERE/launch_one.sh" {}
echo "起動: $(docker ps --filter name=devsim- -q | wc -l | tr -d ' ') 個（$(date -u +%H:%M:%S) UTC）。ログ: $LOGS_DIR"
