#!/bin/bash
# 既存の /opt/factoreye/.offsite-s3.env（本番のバックアップを R2 に送る鍵）から、pgbackrest.conf を作る。
# 鍵を貼り付けなくてよく、画面にも出さない。作ったファイルは、権限 600、所有者 postgres（uid 70。root で実行したとき）。
# 使い方: sudo infra/pgbackrest/make-conf.sh          （すでにあるときは、上書きしない。FORCE=1 で上書き）
# 環境変数: OFFSITE_ENV（読む鍵のファイル）、CONF_DIR（出力先。既定 /opt/factoreye/pgbackrest）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${OFFSITE_ENV:-/opt/factoreye/.offsite-s3.env}"
DEST_DIR="${CONF_DIR:-/opt/factoreye/pgbackrest}"
DEST="$DEST_DIR/pgbackrest.conf"
die() { echo "エラー: $*" >&2; exit 1; }

[ -r "$SRC" ] || die "鍵のファイルを読めません: $SRC"
[ -r "$HERE/pgbackrest.conf.example" ] || die "pgbackrest.conf.example がありません"
if [ -e "$DEST" ] && [ "${FORCE:-0}" != 1 ]; then die "$DEST はすでにあります（上書きするなら FORCE=1）"; fi

# このファイルは Docker の --env-file の形式（シェルではない）。source すると、記号を含む値が壊れるので、行ごとに値を取り出す
get() { awk -F= -v k="$1" '$1==k { sub(/^[^=]*=/, ""); print; exit }' "$SRC"; }
AWS_ENDPOINT_URL="$(get AWS_ENDPOINT_URL)"; AWS_ACCESS_KEY_ID="$(get AWS_ACCESS_KEY_ID)"; AWS_SECRET_ACCESS_KEY="$(get AWS_SECRET_ACCESS_KEY)"
[ -n "$AWS_ENDPOINT_URL" ] || die "$SRC に AWS_ENDPOINT_URL がありません"
[ -n "$AWS_ACCESS_KEY_ID" ] || die "$SRC に AWS_ACCESS_KEY_ID がありません"
[ -n "$AWS_SECRET_ACCESS_KEY" ] || die "$SRC に AWS_SECRET_ACCESS_KEY がありません"
H="${AWS_ENDPOINT_URL#https://}"; H="${H%/}"        # pgBackRest は、https:// なしのホスト名
case "$H" in *"/"*|"") die "AWS_ENDPOINT_URL の形が想定外です（https://<ホスト名> の形）" ;; esac
export H K="$AWS_ACCESS_KEY_ID" S="$AWS_SECRET_ACCESS_KEY"

umask 077
mkdir -p "$DEST_DIR"
# 鍵は、環境変数から読む（awk の -v だと、バックスラッシュが解釈されるため）
awk '
  /^repo1-s3-endpoint=/   { print "repo1-s3-endpoint=" ENVIRON["H"]; next }
  /^repo1-s3-key=/        { print "repo1-s3-key=" ENVIRON["K"]; next }
  /^repo1-s3-key-secret=/ { print "repo1-s3-key-secret=" ENVIRON["S"]; next }
  { print }
' "$HERE/pgbackrest.conf.example" > "$DEST"
chmod 600 "$DEST"
if [ "$(id -u)" = 0 ]; then chown 70:70 "$DEST"; else echo "注意: root ではないので、所有者を uid 70 にしていません（sudo で実行してください）" >&2; fi
grep -v '^#' "$DEST" | grep -q '<' && die "<...> のプレースホルダが残っています: $DEST"
echo "作りました: ${DEST}（エンドポイント ${H}。鍵は表示しません）"
