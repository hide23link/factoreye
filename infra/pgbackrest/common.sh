#!/bin/bash
# pgBackRest のスクリプトの共通部分（source して使う）。本番の LXC の /opt/factoreye で動かす想定。
# 環境変数で上書きできる: COMPOSE_FILE（既定 docker-compose.cloud.yml）、PG_SERVICE（postgres）、STANZA（factoreye）、
#   POSTGRES_USER（factoreye）、POSTGRES_DB（factoreye）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.cloud.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
STANZA="${STANZA:-factoreye}"
POSTGRES_USER="${POSTGRES_USER:-factoreye}"
POSTGRES_DB="${POSTGRES_DB:-factoreye}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { log "エラー: $*"; exit 1; }

# PostgreSQL のコンテナの中で、postgres ユーザーとして実行する（-T: 端末を使わない。cron で動かせるように）
in_pg() { docker compose -f "$COMPOSE_FILE" exec -T -u postgres "$PG_SERVICE" "$@"; }
pgbr() { in_pg pgbackrest --stanza="$STANZA" "$@"; }
sql() { in_pg psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$1"; }

wait_ready() {
  local i
  for i in $(seq 1 60); do
    in_pg pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "PostgreSQL が 2 分以内に起動しませんでした"
}
