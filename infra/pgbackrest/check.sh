#!/bin/bash
# バックアップが使える状態か確かめる（毎日）。
#   check  : WAL を 1 つ送って、R2 に届くか。archive_command が動いているか
#   verify : R2 のバックアップと WAL の、欠け・破損がないか（全ファイルを読んで、チェックサムを確かめる）
# 失敗すると、終了コードが 0 以外。WAL に欠けがあると、その後ろが復旧できないので、早く気づくための確認。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

wait_ready
log "pgbackrest check"
pgbr check
log "pgbackrest verify"
pgbr verify
log "R2 の状態:"
pgbr info | sed -n '1,30p'
log "OK"
