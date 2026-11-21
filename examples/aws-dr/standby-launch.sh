#!/bin/bash
# 緊急時の控えを、空きのあるところに起動する。順番: 東京のスポット（AZ ごと）→ 大阪のスポット → ムンバイのスポット
# （→ 最後の手段としてオンデマンド。ALLOW_ONDEMAND=1 のとき、同じ順番で）。空きが無い（InsufficientInstanceCapacity）と次へ進む。
#
#   standby-launch.sh [--dry-run]
#
# 設定ファイル（既定 ~/.factoreye-dr-standby.conf）: 1 行 1 候補。「リージョン AZ AMI サブネット セキュリティグループ インスタンスプロファイル」
#   例: ap-northeast-1 ap-northeast-1a resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 subnet-0abc sg-0abc factoreye-dr-prof
# AMI は標準の Amazon Linux 2023（上の resolve:ssm: で、どのリージョンでも最新）。サブネットはリージョンごとに別。
# 中身は user-data（既定 standby-userdata.sh）が、R2 の起動の一式（publish-boot.sh）から組み立てる。
# 環境変数: AWS_BIN（既定 aws）、INSTANCE_TYPE（既定 t3.small）、USERDATA_FILE（既定 このフォルダの standby-userdata.sh。空にすると渡さない）、
#   DR_CONF、ALLOW_ONDEMAND
set -uo pipefail

CONF="${DR_CONF:-$HOME/.factoreye-dr-standby.conf}"
USERDATA_FILE="${USERDATA_FILE-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/standby-userdata.sh}"
AWS_BIN="${AWS_BIN:-aws}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
DRY=""; [ "${1:-}" = "--dry-run" ] && DRY="--dry-run"
log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

[ -f "$CONF" ] || { echo "設定ファイルがありません: $CONF" >&2; exit 2; }

try() { # 市場（spot|ondemand） リージョン AZ AMI サブネット SG プロファイル
  local market=$1 region=$2 az=$3 ami=$4 subnet=$5 sg=$6 prof=$7 out rc
  local opts=()
  [ "$market" = spot ] && opts+=(--instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}')
  [ -n "${USERDATA_FILE:-}" ] && opts+=(--user-data "file://$USERDATA_FILE")
  out=$("$AWS_BIN" ec2 run-instances --region "$region" $DRY --image-id "$ami" --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile "Name=$prof" \
    --network-interfaces "DeviceIndex=0,SubnetId=$subnet,Groups=$sg,Ipv6AddressCount=1" \
    --metadata-options "HttpTokens=required,HttpEndpoint=enabled,HttpProtocolIpv6=enabled" \
    --instance-initiated-shutdown-behavior terminate \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Project,Value=factoreye-dr},{Key=Name,Value=factoreye-dr-standby}]' \
    "${opts[@]}" --query 'Instances[0].InstanceId' --output text 2>&1); rc=$?
  if [ -n "$DRY" ] && echo "$out" | grep -q DryRunOperation; then log "起動できる見込み: $market $region $az"; echo "dry-run $market $region $az"; return 0; fi
  if [ $rc -eq 0 ]; then log "起動した: $market $region $az $out"; echo "$out $region $az"; return 0; fi
  log "だめだった（$market $region ${az}）: $(echo "$out" | tail -1 | cut -c1-120)"
  return 1
}

markets=(spot); [ "${ALLOW_ONDEMAND:-0}" = 1 ] && markets+=(ondemand)
for m in "${markets[@]}"; do
  while read -r region az ami subnet sg prof; do
    case "$region" in ''|\#*) continue ;; esac
    try "$m" "$region" "$az" "$ami" "$subnet" "$sg" "$prof" && exit 0
  done < "$CONF"
done
log "どこにも起動できなかった"; exit 1
