#!/bin/bash
# WAL-G の設定（walg.env）を作る。R2 の鍵（専用バケット factoreye-db だけの Object Read & Write）が入ったファイルから、
# walg.env.example の 3 行（Access Key ID・Secret・エンドポイント）を埋めて、権限 600 で書く。鍵は、画面に出さない。
# 鍵のファイル（Docker の --env-file の形式。AWS_ACCESS_KEY_ID、AWS_SECRET_ACCESS_KEY、AWS_ENDPOINT_URL）は、Mac の ~/.factoreye-db-r2.env を、
#   本番の /opt/factoreye/walg/r2.env に、権限 600 で置く（例: Mac から  ssh factoreye 'umask 077; mkdir -p /opt/factoreye/walg; cat > /opt/factoreye/walg/r2.env' < ~/.factoreye-db-r2.env ）
# 使い方: sudo infra/walg/make-conf.sh          （すでにあるときは、上書きしない。FORCE=1 で上書き）
# 環境変数: R2_ENV（鍵のファイル。既定 /opt/factoreye/walg/r2.env）、CONF_DIR（出力先。既定 /opt/factoreye/walg）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${R2_ENV:-/opt/factoreye/walg/r2.env}"
DEST_DIR="${CONF_DIR:-/opt/factoreye/walg}"
DEST="$DEST_DIR/walg.env"
die() { echo "エラー: $*" >&2; exit 1; }

[ -r "$SRC" ] || die "鍵のファイルを読めません: $SRC"
[ -r "$HERE/walg.env.example" ] || die "walg.env.example がありません"
if [ -e "$DEST" ] && [ "${FORCE:-0}" != 1 ]; then die "$DEST はすでにあります（上書きするなら FORCE=1）"; fi

# Docker の --env-file の形式（シェルではない）。source すると、記号を含む値が壊れるので、行ごとに値を取り出す
get() { awk -F= -v k="$1" '$1==k { sub(/^[^=]*=/, ""); print; exit }' "$SRC"; }
K="$(get AWS_ACCESS_KEY_ID)"; S="$(get AWS_SECRET_ACCESS_KEY)"; E="$(get AWS_ENDPOINT_URL)"
[ -n "$K" ] || die "$SRC に AWS_ACCESS_KEY_ID がありません"
[ -n "$S" ] || die "$SRC に AWS_SECRET_ACCESS_KEY がありません"
[ -n "$E" ] || die "$SRC に AWS_ENDPOINT_URL がありません"
case "$E" in https://*) ;; *) die "AWS_ENDPOINT_URL の形が想定外です（https://<ホスト名>）" ;; esac
export K S E

umask 077
mkdir -p "$DEST_DIR"
# 鍵は、環境変数から読む（awk の -v だと、バックスラッシュが解釈されるため）
awk '
  /^AWS_ACCESS_KEY_ID=/     { print "AWS_ACCESS_KEY_ID=" ENVIRON["K"]; next }
  /^AWS_SECRET_ACCESS_KEY=/ { print "AWS_SECRET_ACCESS_KEY=" ENVIRON["S"]; next }
  /^AWS_ENDPOINT=/          { print "AWS_ENDPOINT=" ENVIRON["E"]; next }
  { print }
' "$HERE/walg.env.example" > "$DEST"
chmod 600 "$DEST"
grep -v '^#' "$DEST" | grep -qE '^[A-Z_0-9]+=<' && die "<...> のプレースホルダが残っています: $DEST"
echo "作りました: ${DEST}（エンドポイント ${E}。鍵は表示しません）"
