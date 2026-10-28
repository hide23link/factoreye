#!/bin/bash
# WAL-G を有効にする（初回だけ。何度実行しても安全）。順番: ① 設定がコンテナにあるか確かめる → ② R2 に届くか確かめる → ③ archive_* を設定 → ④ 再起動 → ⑤ WAL が届くか確認
# R2 に届かない状態で archive_mode を入れると、WAL の送信が失敗し続け、pg_wal が溜まる。だから、先に届くかを確かめる。
# 前提: /opt/factoreye/walg/walg.env がある（make-conf.sh）。docker compose up -d postgres で、コンテナに渡っている。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

wait_ready
need_walg_env

log "R2 に届くか確かめる（バックアップの一覧。空でもよい）"
walg backup-list >/dev/null 2>&1 || die "WAL-G が R2 に届きません。walg.env（鍵・エンドポイント・バケット）を確かめてください（walg backup-list の出力: $(walg backup-list 2>&1 | tail -2 | tr '\n' ' ')）"

ARCHIVE_COMMAND="wal-g wal-push %p"
if [ "$(sql 'show archive_mode')" = "on" ] && [ "$(sql 'show archive_timeout')" = "1min" ] && [ "$(sql 'show archive_command')" = "$ARCHIVE_COMMAND" ]; then
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

log "確認（WAL を 1 つ切り替えて、R2 に届くか）"
before=$(sql "select coalesce(archived_count,0) from pg_stat_archiver")
# 書き込みが無いと、pg_switch_wal() は、何も切り替えない（空の区切りは、そのまま）。確実に WAL を発生させてから、切り替える
sql "select pg_logical_emit_message(true, 'factoreye-init', 'check')" >/dev/null
sql "select pg_switch_wal()" >/dev/null
ok=0
for _ in $(seq 1 30); do
  now=$(sql "select coalesce(archived_count,0) from pg_stat_archiver")
  [ "$now" -gt "$before" ] && { ok=1; break; }
  sleep 2
done
if [ "$ok" != 1 ]; then
  log "エラー: WAL が R2 に届きません。archive_mode は有効のままなので、pg_wal が溜まり続けます（放置しない）。"
  log "  ① /opt/factoreye/walg/walg.env を直して（docker compose up -d postgres で反映）、このスクリプトを再実行する。"
  log "  ② 直せないなら、infra/walg/README.md の「戻し方」で、archive_mode を元に戻す。"
  exit 1
fi
# 有効にした印。monitor.sh が、あとで archive_mode が off に戻っていたら異常として通知する（init.sh を忘れた放置は、印が無いので通知しない）
mkdir -p "${WALG_DIR:-/opt/factoreye/walg}" 2>/dev/null && touch "${WALG_DIR:-/opt/factoreye/walg}/archive-enabled" 2>/dev/null || log "警告: 有効にした印を作れませんでした（監視は続く）"
log "完了。次は、最初の全体のバックアップ: infra/walg/backup.sh full"
