#!/usr/bin/env bash
# 動作確認（スモークテスト）。起動した FactorEye が、一通り動くかを確かめる。
#
# 使い方: ./smoke-test.sh <画面の URL> [管理パスワード]
#   例: ./smoke-test.sh http://192.168.0.20:3001
#       ./smoke-test.sh http://192.168.0.20:3001 'a3f9-01bc-7e42'
# 管理パスワードを渡すと、設定の保存と再起動（値は今のまま書き直すだけ）も確かめる。
# 渡さないときは、見るだけの確認（データも設定も変えない）。
# 終了コード: 0=すべて合格 / 1=不合格あり
set -uo pipefail

BASE_URL="${1:-}"
PASSWORD="${2:-}"
[ -n "$BASE_URL" ] || { echo "使い方: $0 <画面の URL> [管理パスワード]" >&2; exit 1; }
BASE_URL="${BASE_URL%/}"
# 再起動の確認を待つ回数（0.5 秒ごと。120 回 = 60 秒）
RESTART_WAIT_SECONDS=120

failed=0
pass() { printf '  合格: %s\n' "$1"; }
fail() { printf '  不合格: %s\n' "$1"; failed=1; }

# 状態コードだけを返す
status_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "1. 画面と API の入口 ($BASE_URL)"
[ "$(status_of "$BASE_URL/health")" = "200" ] && pass "/health が 200" || fail "/health が 200 でない"
[ "$(status_of "$BASE_URL/")" = "200" ] && pass "画面（/）が 200" || fail "画面（/）が 200 でない"
[ "$(status_of "$BASE_URL/api/sensors")" = "200" ] && pass "/api/sensors が 200（/api が backend に届く）" || fail "/api/sensors が 200 でない"

echo "2. 設定の API"
settings="$(curl -s "$BASE_URL/api/settings/runtime")"
case "$settings" in
  *'"ingestAuth"'*'"passwordConfigured"'*) pass "設定を取得できた" ;;
  *) fail "設定を取得できない: $settings" ;;
esac
case "$settings" in
  *jwt*|*JWT*|*password_hash*|*'$2b$'*) fail "設定の応答に秘密の値が含まれている" ;;
  *) pass "設定の応答に秘密の値が含まれていない" ;;
esac

echo "3. 取り込みの認証"
auth="$(printf '%s' "$settings" | sed -n 's/.*"ingestAuth":"\([a-z]*\)".*/\1/p')"
if [ "$auth" = "key" ]; then
  code="$(status_of -X POST "$BASE_URL/api/ingest/readings" -H 'Content-Type: application/json' \
    -d '{"ingestKey":"smoke-test","value":1}')"
  [ "$code" = "401" ] && pass "キーなしの取り込みは 401" || fail "キーなしの取り込みが 401 でない（$code）"
else
  pass "取り込みの認証は off のため、キーなしの確認は飛ばした"
fi

echo "4. 設定の変更と再起動"
if [ -z "$PASSWORD" ]; then
  echo "  （管理パスワードが渡されていないので飛ばした）"
else
  wrong="$(status_of -X POST "$BASE_URL/api/settings/runtime/unlock" -H 'Content-Type: application/json' \
    -d '{"password":"wrong-password-for-smoke-test"}')"
  [ "$wrong" = "401" ] && pass "違うパスワードは 401" || fail "違うパスワードが 401 でない（$wrong）"

  body="$(curl -s -X POST "$BASE_URL/api/settings/runtime/unlock" -H 'Content-Type: application/json' \
    -d "{\"password\":\"$PASSWORD\"}")"
  token="$(printf '%s' "$body" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  if [ -z "$token" ]; then
    fail "管理パスワードで解錠できない: $body"
  else
    pass "管理パスワードで解錠できた"
    cache="$(printf '%s' "$settings" | sed -n 's/.*"ingestCacheSeconds":\([0-9.]*\).*/\1/p')"
    # 今と同じ値を書き直すだけ（設定は変わらないが、保存と再起動の経路は通る）
    saved="$(curl -s -X PUT "$BASE_URL/api/settings/runtime" -H "X-Settings-Token: $token" \
      -H 'Content-Type: application/json' -d "{\"values\":{\"INGEST_CACHE_SECONDS\":\"$cache\"}}")"
    case "$saved" in
      *'"restarting":true'*)
        pass "保存を受け付けた（再起動を待つ）"
        # 停止（応答が止まる）を一度見てから、戻るのを待つ。止まりを見ないと、再起動前の応答を「戻った」と誤認する
        waited=0
        saw_down=0
        while [ "$waited" -lt "$RESTART_WAIT_SECONDS" ]; do
          sleep 0.5
          waited=$((waited + 1))
          code="$(status_of --max-time 2 "$BASE_URL/health")"
          if [ "$code" != "200" ]; then
            saw_down=1
          elif [ "$saw_down" = "1" ]; then
            break
          fi
        done
        if [ "$saw_down" = "1" ] && [ "$(status_of "$BASE_URL/health")" = "200" ]; then
          pass "再起動して戻った（約 $((waited / 2)) 秒）"
        elif [ "$saw_down" = "0" ]; then
          fail "再起動を確認できない（応答が一度も止まらなかった）"
        else
          fail "再起動から戻らない"
        fi
        ;;
      *) fail "保存できない: $saved" ;;
    esac
  fi
fi

echo
if [ "$failed" -eq 0 ]; then echo "結果: すべて合格"; else echo "結果: 不合格があります"; fi
exit "$failed"
