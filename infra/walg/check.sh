#!/bin/bash
# バックアップが使える状態か確かめる（毎日）。
#   backup-list : ベースバックアップが 1 つ以上ある
#   wal-verify  : WAL に欠けがない（欠けがあると、その後ろが復旧できない）
# 失敗すると、終了コードが 0 以外。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

wait_ready
need_walg_env
log "backup-list"
LIST="$(walg backup-list 2>&1)"
echo "$LIST" | tail -5
[ "$(echo "$LIST" | grep -c '^base_')" -ge 1 ] || die "ベースバックアップがありません（infra/walg/backup.sh full）"
log "wal-verify（欠けの確認）"
OUT="$(walg wal-verify integrity 2>&1)" || { echo "$OUT" | tail -12; die "wal-verify が失敗しました"; }
echo "$OUT" | tail -12
echo "$OUT" | grep -q 'integrity check status: OK' || die "WAL に欠けがあります（上の表を確認）"
log "OK"
