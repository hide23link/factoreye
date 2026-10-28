#!/bin/bash
# シェルスクリプトで、変数名の直後に全角などの文字が続く `$VAR（` の形がないか調べる。
# ロケール未設定（C ロケール。cron がそう）だと、全角の文字が変数名の一部として解釈され、set -u でエラーになる。
# 正しくは `${VAR}（`。実行: infra/tests/test-no-bare-var-before-multibyte.sh
# perl で調べる（macOS の grep は -P に対応せず、見逃すため）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
bad=$(perl -ne 'next if /^\s*#/; print "$ARGV:$.:$_" if /\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/; close ARGV if eof' infra/*.sh infra/walg/*.sh infra/tests/*.sh 2>/dev/null || true)
if [ -n "$bad" ]; then echo "NG: 変数名の直後に、全角などの文字があります（\${VAR} と書いてください）:" >&2; echo "$bad" >&2; exit 1; fi
echo "OK: 変数名の直後に全角などの文字がある箇所はありません"
