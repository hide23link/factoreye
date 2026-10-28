#!/bin/bash
# pgBackRest を有効にする（初回だけ。何度実行しても安全）。順番が大事:
#   ① アーカイブなしで PostgreSQL を起動 → ② ステンザを作る → ③ archive_* を設定 → ④ 再起動 → ⑤ 確認
# ステンザを作る前に archive_mode を入れると、WAL の送信が失敗し続け、pg_wal が溜まる。
# 前提: /opt/factoreye/pgbackrest/pgbackrest.conf がある（pgbackrest.conf.example を参照）。PostgreSQL が起動している。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

in_pg test -r /etc/pgbackrest/pgbackrest.conf \
  || die "/etc/pgbackrest/pgbackrest.conf を読めません。/opt/factoreye/pgbackrest/pgbackrest.conf を置き、所有者を uid 70、権限を 600 にしてください"
wait_ready

log "ステンザ ${STANZA} を作る（すでにあれば、そのまま）"
pgbr stanza-create

ARCHIVE_COMMAND="pgbackrest --stanza=${STANZA} archive-push %p"
if [ "$(sql 'show archive_mode')" = "on" ] && [ "$(sql 'show archive_timeout')" = "1min" ] \
   && [ "$(sql 'show archive_command')" = "$ARCHIVE_COMMAND" ]; then
  log "archive_mode はすでに有効です（設定を変えません）"
else
  log "archive_mode・archive_command・archive_timeout（60 秒）を設定する"
  sql "ALTER SYSTEM SET archive_mode = on" >/dev/null
  sql "ALTER SYSTEM SET archive_command = '${ARCHIVE_COMMAND}'" >/dev/null
  sql "ALTER SYSTEM SET archive_timeout = 60" >/dev/null
  log "PostgreSQL を再起動する（archive_mode の変更には再起動が要る。数秒、DB が止まる）"
  docker compose -f "$COMPOSE_FILE" restart "$PG_SERVICE" >/dev/null
  wait_ready
fi

log "確認（WAL を 1 つ送って、R2 に届くか）"
if ! pgbr check; then
  log "エラー: check に失敗しました。archive_mode は有効のままなので、WAL を R2 に送れず、pg_wal が溜まり続けます（放置しない）。"
  log "  ① R2 の設定（/opt/factoreye/pgbackrest/pgbackrest.conf: エンドポイントは https:// なし、鍵、バケット）を直して、このスクリプトを再実行する。"
  log "  ② 直せないなら、infra/pgbackrest/README.md の「戻し方」で、archive_mode を元に戻す。"
  exit 1
fi
log "完了。次は、最初の全体のバックアップ: infra/pgbackrest/backup.sh full"
