#!/bin/bash
# PostgreSQLの日次バックアップ（docs/factoreye-architecture.md §バックアップ 準拠）。
# 本番運用者がcronで `0 3 * * * /path/to/factoreye/infra/backup.sh` のように毎日3時に実行する想定。
# コンテナ名を直接指定せず `docker compose exec <service名>` を使うことで、
# compose project名（ディレクトリ名）がホストによって変わっても動作する。
set -euo pipefail

# このスクリプトの場所からリポジトリルート（docker-compose.ymlがある場所）を特定する
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-factoreye}"
POSTGRES_USER="${POSTGRES_USER:-factoreye}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/factoreye-$TIMESTAMP.sql.gz"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

mkdir -p "$BACKUP_DIR"

log "バックアップ開始: $DEST"

# -T: ttyを確保しない（cron等の非対話実行でpg_dumpの出力がTTY制御文字で壊れるのを防ぐ）
if ! docker compose exec -T "$POSTGRES_SERVICE" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$DEST"; then
  log "エラー: pg_dumpに失敗しました"
  rm -f "$DEST"
  exit 1
fi

if [ ! -s "$DEST" ]; then
  log "エラー: バックアップファイルが空です（$DEST）"
  rm -f "$DEST"
  exit 1
fi

log "バックアップ完了: $DEST ($(du -h "$DEST" | cut -f1))"

log "保持期間（${RETENTION_DAYS}日）を過ぎたバックアップを削除します"
find "$BACKUP_DIR" -name "factoreye-*.sql.gz" -mtime "+$RETENTION_DAYS" -print -delete

log "完了"
