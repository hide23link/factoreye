#!/bin/bash
# LAN 向けの取り込みの窓口（nginx）が、決めたとおりに通して・断っているかを確かめる。
# LAN の別のマシン（機器と同じ立場）から実行する。使い方:
#   ./infra/lan-ingest/verify.sh http://192.168.0.72:8001            # 通す・断るの確認
#   ./infra/lan-ingest/verify.sh http://192.168.0.72:8001 --rate-test  # さらに、レート制限が偽装で避けられないかを確認（約 1 分、制限を使い切る）
#
# 取り込みの確認は、わざと壊した本文（{}）を送る。センサーは作らず、データも増えない。
# 期待: backend に届いていれば 400（INGEST_AUTH=off）か 401（INGEST_AUTH=key）。届いていなければ 404・403・接続できない。
set -uo pipefail

BASE="${1:?使い方: verify.sh http://<ホストの IP>:<ポート> [--rate-test]}"
BASE="${BASE%/}"
failures=0

# 期待するステータスコードかを確かめる。引数: 説明 / 期待（| 区切りで複数可）/ curl の引数
check() {
  local name="$1" expected="$2"
  shift 2
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@" || true)
  if [[ "|$expected|" == *"|$code|"* ]]; then
    echo "  OK  $name（$code）"
  else
    echo "  NG  $name: $code（期待 $expected）"
    failures=$((failures + 1))
  fi
}

echo "通すもの"
check "GET /health" "200" "$BASE/health"
check "POST /api/ingest/readings（本文が空）が backend に届く" "400|401|422" \
  -X POST -H "Content-Type: application/json" -d '{}' "$BASE/api/ingest/readings"

echo "断るもの（LAN に出さない）"
check "GET /api/ingest/readings（POST 以外）" "403" "$BASE/api/ingest/readings"
check "GET /api/sensors" "404" "$BASE/api/sensors"
check "POST /api/sensors" "404" -X POST -H "Content-Type: application/json" -d '{}' "$BASE/api/sensors"
check "GET /api/admin/ingest-limit" "404" "$BASE/api/admin/ingest-limit"
check "PUT /api/admin/ingest-limit" "404" -X PUT -H "Content-Type: application/json" -d '{}' "$BASE/api/admin/ingest-limit"
check "GET /docs" "404" "$BASE/docs"
check "GET /openapi.json" "404" "$BASE/openapi.json"
check "GET /" "404" "$BASE/"
check "POST /health" "403" -X POST "$BASE/health"
big_body="$(mktemp)"
trap 'rm -f "$big_body"' EXIT
head -c 300000 /dev/zero | tr '\0' 'a' > "$big_body"
check "大きすぎる本文（300KB）" "413" \
  -X POST -H "Content-Type: application/json" --data-binary "@$big_body" "$BASE/api/ingest/readings"

if [[ "${2:-}" == "--rate-test" ]]; then
  echo "レート制限（既定 100 回/分）が、偽装した CF-Connecting-IP で避けられないか"
  # 毎回違う CF-Connecting-IP を付けて 110 回送る。窓口がヘッダーを上書きしていれば、同じ接続元として数えられ、429 が返る
  too_many=0
  for i in $(seq 1 110); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -X POST -H "Content-Type: application/json" \
      -H "CF-Connecting-IP: 10.99.$((i / 250)).$((i % 250 + 1))" -d '{}' "$BASE/api/ingest/readings" || true)
    [[ "$code" == "429" ]] && too_many=$((too_many + 1))
  done
  if ((too_many > 0)); then
    echo "  OK  偽装しても 429 になった（$too_many 回）"
  else
    echo "  NG  429 にならなかった。ヘッダーが上書きされていない、または INGEST_RATE_LIMIT=off の可能性"
    failures=$((failures + 1))
  fi
fi

echo
if ((failures == 0)); then
  echo "すべて期待どおりです"
else
  echo "$failures 件が期待と違います"
  exit 1
fi
