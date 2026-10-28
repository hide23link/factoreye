#!/bin/bash
# infra/pgbackrest/make-conf.sh の試験（Docker 不要）。実行: infra/tests/test-make-conf.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "NG: $*" >&2; exit 1; }
# 記号を含む鍵でも壊れないこと（/ + = & \ を含める）
cat > "$T/env" <<'Y'
AWS_ACCESS_KEY_ID=AKID/te+st=1
AWS_SECRET_ACCESS_KEY=se/cr+et=&abc\def
AWS_DEFAULT_REGION=auto
AWS_ENDPOINT_URL=https://acct123.r2.cloudflarestorage.com
Y
run() { OFFSITE_ENV="$T/env" CONF_DIR="$T/out" "$ROOT/infra/pgbackrest/make-conf.sh" "$@"; }
OUT=$(run 2>&1) || fail "作れない: $OUT"
C="$T/out/pgbackrest.conf"
grep -qx 'repo1-s3-endpoint=acct123.r2.cloudflarestorage.com' "$C" || fail "エンドポイント（https:// なし）が違う"
grep -qxF 'repo1-s3-key=AKID/te+st=1' "$C" || fail "Access Key ID が違う"
grep -qxF 'repo1-s3-key-secret=se/cr+et=&abc\def' "$C" || fail "Secret が違う（記号の扱い）"
grep -v '^#' "$C" | grep -q '<' && fail "プレースホルダが残っている"
[ "$(stat -f %Lp "$C" 2>/dev/null || stat -c %a "$C")" = 600 ] || fail "権限が 600 でない"
echo "$OUT" | grep -q 'AKID\|se/cr' && fail "鍵が画面に出ている"
grep -qx 'repo1-bundle=y' "$C" && grep -qx 'pg1-user=factoreye' "$C" || fail "雛形のほかの設定が消えている"
# すでにあるときは、上書きしない
if run >/dev/null 2>&1; then fail "上書きを拒否しない"; fi
FORCE=1 run >/dev/null 2>&1 || fail "FORCE=1 で上書きできない"
# 鍵のファイルが無い・項目が足りない
if OFFSITE_ENV="$T/none" CONF_DIR="$T/o2" "$ROOT/infra/pgbackrest/make-conf.sh" >/dev/null 2>&1; then fail "鍵のファイルなしで成功"; fi
echo 'AWS_ACCESS_KEY_ID=x' > "$T/env2"
if OFFSITE_ENV="$T/env2" CONF_DIR="$T/o3" "$ROOT/infra/pgbackrest/make-conf.sh" >/dev/null 2>&1; then fail "項目不足で成功"; fi
echo "OK: make-conf.sh の 7 項目"
