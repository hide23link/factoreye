#!/bin/bash
# 本番のバックアップを、別のマシン（ラズパイなど）から取りに行く。取りに行く側の cron で実行する。
#   例: 30 3 * * * /home/pi/factoreye-offsite/offsite-pull.sh >> /home/pi/factoreye-offsite/pull.log 2>&1
#
# 取りに行く方式にするのは、本番が乗っ取られても、こちらの控えを本番側から消せないようにするため。
# 本番には、この鍵で「読むだけ・backups/ だけ」に限った接続しか許さない（rrsync -ro。手順は infra/README.md）。
# 既にあるファイルは取り直さない（本番で書き換えられたものに上書きされないように）。
set -euo pipefail

# 本番への接続先（例: root@<本番の Tailscale の IP>）。取りに行く側の cron で必ず指定する
OFFSITE_SOURCE="${OFFSITE_SOURCE:?OFFSITE_SOURCE（root@<本番の Tailscale の IP>）を指定してください}"
OFFSITE_SSH_KEY="${OFFSITE_SSH_KEY:-$HOME/.ssh/factoreye_backup}"
# 既定は鍵と同じディレクトリに置く。$HOME/.ssh/known_hosts が別の理由で書けない環境
# （所有者が違う等）でも、ここは自分専用の鍵の置き場所なので必ず書き込める
OFFSITE_KNOWN_HOSTS="${OFFSITE_KNOWN_HOSTS:-$(dirname "$OFFSITE_SSH_KEY")/known_hosts}"
# 既定は $HOME 配下（/srv や /opt は一般利用者の cron からは作れないことが多いため）
OFFSITE_DIR="${OFFSITE_DIR:-$HOME/factoreye-offsite-backups}"
# 本番の 7 日より長く持つ（本番で壊れたことに気づくのが遅れても、壊れる前の版が残るように）
OFFSITE_RETENTION_DAYS="${OFFSITE_RETENTION_DAYS:-90}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

mkdir -p "$OFFSITE_DIR"
# グループには読ませる（復旧ツールは BACKUP_GID にこの利用者のグループを指定して読む）
chmod 750 "$OFFSITE_DIR"

# ホスト鍵を初回だけ自動で登録する。本物かどうかは、運用者が初回に表示される
# fingerprint を、サーバー側で確かめたものと見比べて確認すること（infra/README.md）
if [ ! -s "$OFFSITE_KNOWN_HOSTS" ]; then
  host="${OFFSITE_SOURCE#*@}"
  log "ホスト鍵が無いため、$host から取得します（初回のみ）"
  ssh-keyscan -t ed25519 "$host" > "$OFFSITE_KNOWN_HOSTS" 2>/dev/null
  ssh-keygen -lf "$OFFSITE_KNOWN_HOSTS" | while read -r line; do log "取得した鍵: $line"; done
fi

log "取得開始: $OFFSITE_SOURCE → $OFFSITE_DIR"
# rrsync -ro が送り元を backups/ に固定しているため、送り元のパスは "/" でよい
rsync -a --ignore-existing --include 'factoreye-*' --exclude '*' \
  -e "ssh -i $OFFSITE_SSH_KEY -o UserKnownHostsFile=$OFFSITE_KNOWN_HOSTS -o BatchMode=yes" \
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
