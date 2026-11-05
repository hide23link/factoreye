#!/bin/bash
# infra/backup.sh の BACKUP_DB=off（設定ファイルだけを保存）の試験。Docker も PostgreSQL も要らない。
# 実行: infra/tests/test-backup-config-only.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "NG: $*" >&2; exit 1; }

mkdir -p "$T/repo/infra" "$T/backups"
cp "$ROOT/infra/backup.sh" "$T/repo/infra/backup.sh"
echo "SECRET=abc" > "$T/repo/.env"
printf 'pass-for-test' > "$T/pass"; chmod 600 "$T/pass"
run() { BACKUP_DIR="$T/backups" BACKUP_PASSPHRASE_FILE="$T/pass" BACKUP_CONFIG_FILES=".env" "$@" "$T/repo/infra/backup.sh"; }

# 1. BACKUP_DB=off: 設定ファイルだけができる（ダンプは作らない）
env BACKUP_DB=off BACKUP_DIR="$T/backups" BACKUP_PASSPHRASE_FILE="$T/pass" BACKUP_CONFIG_FILES=".env" "$T/repo/infra/backup.sh" >/dev/null
ls "$T/backups" | grep -q 'config\.tar\.gz\.enc$' || fail "設定ファイルのバックアップができていない"
ls "$T/backups" | grep -q 'config\.tar\.gz\.enc\.sha256$' || fail "設定ファイルの sha256 がない"
ls "$T/backups" | grep -q '\.sql\.gz' && fail "BACKUP_DB=off なのにダンプができている"
# 復号して、中身が戻る
F=$(ls "$T/backups"/*config.tar.gz.enc)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$T/pass" -in "$F" | tar -xzOf - "${T#/}/repo/.env" 2>/dev/null | grep -q 'SECRET=abc' || fail "復号した中身が違う"
(cd "$T/backups" && sha256sum -c "$(basename "$F").sha256" >/dev/null) || fail "sha256 が合わない"

# 2. BACKUP_DB=off で、合言葉のファイルが無いと、エラーで止まる
if env BACKUP_DB=off BACKUP_DIR="$T/b2" "$T/repo/infra/backup.sh" >/dev/null 2>&1; then fail "合言葉なしで成功してしまった"; fi

# 3. BACKUP_DB に不正な値だと、エラーで止まる
if env BACKUP_DB=maybe BACKUP_DIR="$T/b3" "$T/repo/infra/backup.sh" >/dev/null 2>&1; then fail "不正な BACKUP_DB で成功してしまった"; fi

echo "OK: BACKUP_DB=off の 3 項目"
