#!/bin/bash
# WAL-G のスクリプトの共通部分（source して使う）。本番の LXC の /opt/factoreye で動かす想定。
# 環境変数で上書きできる: COMPOSE_FILE（既定 docker-compose.cloud.yml）、PG_SERVICE（postgres）、POSTGRES_USER（factoreye）、POSTGRES_DB（factoreye）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.cloud.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
POSTGRES_USER="${POSTGRES_USER:-factoreye}"
POSTGRES_DB="${POSTGRES_DB:-factoreye}"
PGDATA_DIR="/var/lib/postgresql/data"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { log "エラー: $*"; exit 1; }

# PostgreSQL のコンテナの中で、postgres ユーザーとして実行する（-T: 端末を使わない。cron で動かせるように）
in_pg() { docker compose -f "$COMPOSE_FILE" exec -T -u postgres "$PG_SERVICE" "$@"; }
walg() { in_pg wal-g "$@"; }
sql() { in_pg psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$1"; }

# Discord に通知する（Webhook のファイルがあるときだけ。同じ状態ファイルで、1 時間に 1 回まで）。使い方: notify "本文" "状態ファイル"
WEBHOOK_FILE="${WEBHOOK_FILE:-/opt/factoreye/walg/discord-webhook}"
notify() {
  [ -r "$WEBHOOK_FILE" ] || return 0
  local now last body
  now=$(date +%s); last=$(cat "$2" 2>/dev/null || echo 0)
  [ $((now - last)) -ge 3600 ] || return 0
  body=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
  if curl -s -m 10 -o /dev/null -H 'Content-Type: application/json' -d "{\"content\":\"🔴 ${body}\"}" "$(cat "$WEBHOOK_FILE")"; then echo "$now" > "$2"; else log "Discord への通知に失敗しました"; fi
}
# 失敗したら（終了コードが 0 でも 2 でもない）通知する。2 は monitor.sh が異常を通知済みの印。cron で動かすスクリプトの先頭で呼ぶ
notify_on_failure() {
  NOTIFY_NAME="$1"
  trap '_rc=$?; if [ "$_rc" -ne 0 ] && [ "$_rc" -ne 2 ]; then notify "factoreye 本番の DB のバックアップの処理（${NOTIFY_NAME}）が失敗しました（終了コード ${_rc}）。ログ /var/log/factoreye-walg.log と infra/walg/README.md の「異常のとき」を確認" "/var/tmp/factoreye-walg-fail-${NOTIFY_NAME}"; fi' EXIT
}
# WAL-G の置き場が、専用バケット（factoreye-db）か。delete は置き場の下の WAL をすべて対象にするので、共有バケットでは実行しない（試験用のローカルの置き場は許す）
require_dedicated_prefix() {
  local p; p="$(in_pg sh -c 'printenv WALG_S3_PREFIX || printenv WALG_FILE_PREFIX' 2>/dev/null | tr -d '\r')"
  case "$p" in s3://factoreye-db|s3://factoreye-db/|/var/lib/walg-repo) ;; *) die "WAL-G の置き場が専用バケットではありません（${p:-未設定}）。delete が他のバックアップを消すので、実行しません。WALG_S3_PREFIX=s3://factoreye-db にしてください" ;; esac
}

wait_ready() {
  local i
  for i in $(seq 1 60); do
    in_pg pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "PostgreSQL が 2 分以内に起動しませんでした"
}

# WAL-G の設定（walg.env）が、コンテナに渡っているか。渡っていなければ、コンテナを作り直す必要がある（env_file は、作成時に読まれる）
need_walg_env() {
  if [ -z "$(in_pg sh -c 'printenv WALG_S3_PREFIX || printenv WALG_FILE_PREFIX' 2>/dev/null || true)" ]; then
    die "WAL-G の設定がコンテナにありません。/opt/factoreye/walg/walg.env を作ってから、docker compose -f $COMPOSE_FILE up -d postgres でコンテナを作り直してください"
  fi
}
