#!/bin/bash
# バックアップのファイルを S3 に送る（infra/backup.sh から呼ばれる。単体でも使える）。
#   使い方: OFFSITE_S3_URI=s3://<バケット>/<接頭辞> ./infra/offsite-s3.sh <ファイル>...
#
# 本番が乗っ取られても S3 の控えを消されないように、本番に渡す鍵は「追加だけ」の権限にし、
# バケットのバージョニングを有効にする（上書きされても前の版が残る）。手順は infra/README.md。
# aws CLI をホストに入れずに済むよう、公式の Docker イメージで実行する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OFFSITE_S3_URI="${OFFSITE_S3_URI:?OFFSITE_S3_URI（例: s3://my-bucket/factoreye）を設定してください}"
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION を書いたファイル（Git 管理外・権限 600）
OFFSITE_S3_ENV_FILE="${OFFSITE_S3_ENV_FILE:-$REPO_ROOT/.offsite-s3.env}"
AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:2.17.0}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [ $# -eq 0 ]; then
  echo "使い方: $0 <ファイル>..." >&2
  exit 1
fi
if [ ! -r "$OFFSITE_S3_ENV_FILE" ]; then
  log "エラー: S3 の認証情報のファイルを読めません: $OFFSITE_S3_ENV_FILE"
  exit 1
fi

status=0
for f in "$@"; do
  dir="$(cd "$(dirname "$f")" && pwd)"
  name="$(basename "$f")"
  if docker run --rm --env-file "$OFFSITE_S3_ENV_FILE" -v "$dir:/data:ro" "$AWS_CLI_IMAGE" \
      s3 cp --no-progress "/data/$name" "${OFFSITE_S3_URI%/}/$name" > /dev/null; then
    log "S3 に送りました: ${OFFSITE_S3_URI%/}/$name"
  else
    log "エラー: S3 への送信に失敗しました: $name"
    status=1
  fi
done
exit "$status"
