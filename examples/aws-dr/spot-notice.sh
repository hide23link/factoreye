#!/bin/bash
# スポットの回収の予告（約 2 分前に出る）を、起動の直後から見張り、予告が来たら、R2 に印を書く。DR コンソールが読んで、画面・ログ・Discord に出す。
# standby-boot.sh の復元が終わっていなくても動く（復元の途中で回収されても、見えるように）。秘密情報（/etc/factoreye-dr.env）が来るまで待つ。
# 印: <R2_PREFIX>standby-events/spot-<リージョン>-<インスタンス ID>.json（バケットのロックの接頭辞 factoreye- に当たらない）
# 環境変数: DR_ENV（既定 /etc/factoreye-dr.env）、IMDS_BASE（既定 http://[fd00:ec2::254]）、SPOT_POLL（見張りの間隔の秒。既定 5）、AWS_BIN
set -uo pipefail
DR_ENV="${DR_ENV:-/etc/factoreye-dr.env}"; IMDS="${IMDS_BASE:-http://[fd00:ec2::254]}"; POLL="${SPOT_POLL:-5}"
log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }
imds() {   # $1: パス。IMDSv2。404（予告なし）は空を返す
  local t; t=$(curl -s -m 3 -g -X PUT "$IMDS/latest/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
  curl -s -m 3 -g -f -H "X-aws-ec2-metadata-token: $t" "$IMDS/latest/$1" 2>/dev/null || true
}
until [ -r "$DR_ENV" ]; do sleep 5; done
set -a; . "$DR_ENV"; set +a
: "${R2_ENDPOINT:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
BUCKET="${R2_BUCKET:-factoreye-backup}"; PREFIX="${R2_PREFIX:-}"; PREFIX="${PREFIX%/}"; [ -z "$PREFIX" ] || PREFIX="$PREFIX/"
log "スポットの回収の予告を見張る"
while :; do
  ACTION=$(imds meta-data/spot/instance-action)
  if [ -n "$ACTION" ]; then
    ID=$(imds meta-data/instance-id); REGION=$(imds meta-data/placement/region)
    KEY="${PREFIX}standby-events/spot-${REGION:-unknown}-${ID:-unknown}.json"
    BODY=$(printf '{"instance":"%s","region":"%s","noticed_at":"%s","action":%s}' "$ID" "$REGION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ACTION")
    log "回収の予告を受けた: $ACTION → R2 に印を書く（${KEY}）"
    for _ in 1 2 3 4 5 6; do
      printf '%s' "$BODY" | AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto \
        AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required AWS_USE_DUALSTACK_ENDPOINT=true \
        ${AWS_BIN:-aws} --endpoint-url "$R2_ENDPOINT" s3 cp - "s3://$BUCKET/$KEY" --no-progress >/dev/null 2>&1 && { log "印を書いた"; exit 0; }
      sleep 3
    done
    log "印を書けなかった（R2 に届かない）"; exit 1
  fi
  sleep "$POLL"
done
