#!/bin/bash
# 本番のバックアップを、別のマシン（ラズパイなど）から取りに行く。取りに行く側の cron で実行する。
#   例: 30 3 * * * /opt/factoreye-offsite/offsite-pull.sh >> /var/log/factoreye-offsite.log 2>&1
#
# 取りに行く方式にするのは、本番が乗っ取られても、こちらの控えを本番側から消せないようにするため。
# 本番には、この鍵で「読むだけ・backups/ だけ」に限った接続しか許さない（rrsync -ro。手順は infra/README.md）。
# 既にあるファイルは取り直さない（本番で書き換えられたものに上書きされないように）。
set -euo pipefail

OFFSITE_SOURCE="${OFFSITE_SOURCE:-root@100.70.133.58}"
OFFSITE_SSH_KEY="${OFFSITE_SSH_KEY:-$HOME/.ssh/factoreye_backup}"
OFFSITE_DIR="${OFFSITE_DIR:-/srv/factoreye-backups}"
# 本番の 7 日より長く持つ（本番で壊れたことに気づくのが遅れても、壊れる前の版が残るように）
OFFSITE_RETENTION_DAYS="${OFFSITE_RETENTION_DAYS:-90}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

mkdir -p "$OFFSITE_DIR"
# グループには読ませる（復旧ツールは BACKUP_GID にこの利用者のグループを指定して読む）
chmod 750 "$OFFSITE_DIR"

log "取得開始: $OFFSITE_SOURCE → $OFFSITE_DIR"
# rrsync -ro が送り元を backups/ に固定しているため、送り元のパスは "/" でよい
rsync -a --ignore-existing --include 'factoreye-*' --exclude '*' \
  -e "ssh -i $OFFSITE_SSH_KEY -o BatchMode=yes" \
  "$OFFSITE_SOURCE:/" "$OFFSITE_DIR/"

# 取ってきたファイルを確かめる。合わないものは、本番で壊れたか、途中で壊れたかのどちらか
status=0
cd "$OFFSITE_DIR"
for sum in factoreye-*.sha256; do
  [ -e "$sum" ] || continue
  if ! sha256sum -c --quiet "$sum"; then
    log "エラー: 検証に失敗しました: $sum"
    status=1
  fi
done

log "保持期間（${OFFSITE_RETENTION_DAYS}日）を過ぎたファイルを削除します"
find "$OFFSITE_DIR" -maxdepth 1 -type f -name "factoreye-*" -mtime "+$OFFSITE_RETENTION_DAYS" -print -delete

log "完了"
exit "$status"
