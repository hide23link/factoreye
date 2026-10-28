#!/bin/bash
# ベースバックアップを取る。使い方: backup.sh full | diff
#   full: 全体（週 1 回）。diff: 前回の全体からの差分（毎日。ブロック増分）。
# 動いている DB から、読み取るだけで取れる（停止も、DB の更新もしない）。
# cron の例は README.md。失敗すると、終了コードが 0 以外になる（cron のログ・メールで気づける）。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TYPE="${1:-}"
case "$TYPE" in full|diff) ;; *) die "使い方: backup.sh full | diff" ;; esac

wait_ready
log "ベースバックアップ（${TYPE}）を開始"
pgbr --type="$TYPE" backup
log "完了。R2 の状態:"
pgbr info | sed -n '1,30p'
