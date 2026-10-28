#!/bin/bash
# ベースバックアップを取る。使い方: backup.sh full | delta
#   full : 全体（週 1 回）。取ったあと、古いバックアップと、不要になった WAL を削除する（全体を 1 世代だけ残す）。
#   delta: 前回からの変更分だけ（毎日）。前に全体が無ければ、全体になる。
# 動いている DB から、読み取るだけで取れる（停止も、DB の更新もしない）。失敗すると、終了コードが 0 以外になる。
# **削除（delete）は、専用バケット（factoreye-db）の中だけに及ぶ**（WALG_S3_PREFIX がバケットの直下。walg.env.example の注意）。
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TYPE="${1:-}"
case "$TYPE" in full|delta) ;; *) die "使い方: backup.sh full | delta" ;; esac

notify_on_failure "backup-${1:-}"
wait_ready
need_walg_env
[ "$TYPE" != full ] || require_dedicated_prefix
log "ベースバックアップ（${TYPE}）を開始"
if [ "$TYPE" = full ]; then walg backup-push --full "$PGDATA_DIR"; else walg backup-push "$PGDATA_DIR"; fi
if [ "$TYPE" = full ]; then
  log "古いバックアップと、不要な WAL を削除する（全体を 1 世代だけ残す）"
  walg delete retain FULL 1 --confirm
fi
log "完了。R2 の状態:"
walg backup-list | tail -5
