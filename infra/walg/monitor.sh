#!/bin/bash
# WAL が R2 に送れなくなっていないか、ディスクが埋まりそうでないかを見る（10 分ごとに cron で実行）。
# 送れなくなると、PostgreSQL は WAL（pg_wal）を消せず、溜め続けて、ディスクが埋まると DB が止まる。
# 異常があれば、終了コード 2 で、標準出力に理由を出し、Discord に通知する（1 時間に 1 回まで）。
#   見るもの: ① アーカイブが今、失敗している（pg_stat_archiver）② pg_wal の大きさ ③ ホストの / の使用率
# 環境変数: MAX_WAL_MB（既定 2048）、DISK_PCT（既定 85）、
#   WEBHOOK_FILE（Discord の Webhook の URL を入れたファイル。既定 /opt/factoreye/walg/discord-webhook。無ければ通知しない）
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

MAX_WAL_MB="${MAX_WAL_MB:-2048}"
DISK_PCT="${DISK_PCT:-85}"
STATE_FILE="${STATE_FILE:-/var/tmp/factoreye-walg-alert}"

notify_on_failure monitor
wait_ready
alerts=()
if [ "$(sql 'show archive_mode')" != "on" ]; then
  if [ ! -e "${WALG_DIR:-/opt/factoreye/walg}/archive-enabled" ]; then
    log "archive_mode が off です（有効にする前。見るものがありません）"
    exit 0
  fi
  alerts+=("archive_mode が off です（init.sh で有効にした後に戻っています。WAL が R2 に送られていません）")
fi

# ① アーカイブが今、失敗している: 最後の失敗が、最後の成功より新しい
failing=$(sql "select (last_failed_time is not null and (last_archived_time is null or last_failed_time > last_archived_time)) from pg_stat_archiver")
if [ "$failing" = "t" ]; then
  alerts+=("WAL を R2 に送れていません（pg_stat_archiver: 最後の失敗が最後の成功より新しい。失敗 $(sql 'select failed_count from pg_stat_archiver') 回）")
fi

# ② pg_wal の大きさ
wal_mb=$(in_pg sh -c "du -sm /var/lib/postgresql/data/pg_wal | cut -f1")
if [ "${wal_mb:-0}" -gt "$MAX_WAL_MB" ]; then
  alerts+=("pg_wal が ${wal_mb} MB です（上限 ${MAX_WAL_MB} MB）。送れていない WAL が溜まっています")
fi

# ③ ホストの / の使用率（Docker のデータも、ここにある）
disk=$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ "${disk:-0}" -ge "$DISK_PCT" ]; then
  alerts+=("ディスク（/）の使用率が ${disk}% です（しきい値 ${DISK_PCT}%）")
fi

if [ "${#alerts[@]}" -eq 0 ]; then
  log "OK（アーカイブは正常、pg_wal ${wal_mb} MB、ディスク ${disk}%）"
  rm -f "$STATE_FILE"
  exit 0
fi

joined=""; for a in "${alerts[@]}"; do joined="${joined:+$joined / }$a"; done
msg="factoreye 本番の DB のバックアップに異常: ${joined}。対応は infra/walg/README.md の「異常のとき」"
log "異常: $msg"

notify "$msg" "$STATE_FILE"
exit 2
