#!/bin/bash
# infra/walg/make-conf.sh の試験（Docker 不要）。実行: infra/tests/test-make-conf.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "NG: $*" >&2; exit 1; }
# 記号を含む鍵でも壊れないこと（/ + = & \ を含める）
cat > "$T/r2.env" <<'Y'
AWS_ACCESS_KEY_ID=AKID/te+st=1
AWS_SECRET_ACCESS_KEY=se/cr+et=&abc\def
AWS_ENDPOINT_URL=https://acct123.r2.cloudflarestorage.com
Y
run() { R2_ENV="$T/r2.env" CONF_DIR="$T/out" "$ROOT/infra/walg/make-conf.sh" "$@"; }
OUT=$(run 2>&1) || fail "作れない: $OUT"
C="$T/out/walg.env"
grep -qxF 'AWS_ACCESS_KEY_ID=AKID/te+st=1' "$C" || fail "Access Key ID が違う"
grep -qxF 'AWS_SECRET_ACCESS_KEY=se/cr+et=&abc\def' "$C" || fail "Secret が違う（記号の扱い）"
grep -qx 'AWS_ENDPOINT=https://acct123.r2.cloudflarestorage.com' "$C" || fail "エンドポイントが違う"
grep -qx 'WALG_S3_PREFIX=s3://factoreye-db' "$C" || fail "置き場（専用バケットの直下）が違う"
grep -qx 'PGUSER=factoreye' "$C" || fail "雛形のほかの設定が消えている"
grep -v '^#' "$C" | grep -q '<' && fail "プレースホルダが残っている"
[ "$(stat -f %Lp "$C" 2>/dev/null || stat -c %a "$C")" = 600 ] || fail "権限が 600 でない"
echo "$OUT" | grep -q 'AKID\|se/cr' && fail "鍵が画面に出ている"
# すでにあるときは、上書きしない
if run >/dev/null 2>&1; then fail "上書きを拒否しない"; fi
FORCE=1 run >/dev/null 2>&1 || fail "FORCE=1 で上書きできない"
# 鍵のファイルが無い・項目が足りない・エンドポイントが https でない
if R2_ENV="$T/none" CONF_DIR="$T/o2" "$ROOT/infra/walg/make-conf.sh" >/dev/null 2>&1; then fail "鍵のファイルなしで成功"; fi
echo 'AWS_ACCESS_KEY_ID=x' > "$T/env2"
if R2_ENV="$T/env2" CONF_DIR="$T/o3" "$ROOT/infra/walg/make-conf.sh" >/dev/null 2>&1; then fail "項目不足で成功"; fi
printf 'AWS_ACCESS_KEY_ID=x\nAWS_SECRET_ACCESS_KEY=y\nAWS_ENDPOINT_URL=http://insecure\n' > "$T/env3"
if R2_ENV="$T/env3" CONF_DIR="$T/o4" "$ROOT/infra/walg/make-conf.sh" >/dev/null 2>&1; then fail "https でないエンドポイントで成功"; fi
echo "OK: make-conf.sh の 8 項目"
