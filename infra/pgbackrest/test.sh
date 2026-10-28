#!/bin/bash
# init.sh・backup.sh・check.sh と、復元（WAL の再生まで）を、ローカルの Docker で通して確かめる。R2 には送らない。
# 置き場は、S3 ではなくローカルのディレクトリ（POSIX）。R2（S3 互換）との相性は、ecopower の docs/aws-dr-wal-design.md §12 の試験で確認済み。
# 実行: infra/pgbackrest/test.sh   （Docker が要る。約 2 分。終わると、コンテナとボリュームを消す）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
T="$(mktemp -d)"; P="pgbrtest$$"
export COMPOSE_PROJECT_NAME="$P" COMPOSE_FILE="$T/compose.yml" STANZA=factoreye POSTGRES_USER=factoreye POSTGRES_DB=factoreye
cleanup() { docker compose -f "$T/compose.yml" down -v >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
fail() { echo "NG: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
# 実行して、失敗したときだけ、出力の末尾を表示する
step() { local out; if ! out=$("$@" 2>&1); then echo "$out" | tail -20 >&2; return 1; fi; }

cat > "$T/compose.yml" <<Y
services:
  postgres:
    build: "$ROOT/infra/cloud/postgres"
    environment: { POSTGRES_USER: factoreye, POSTGRES_PASSWORD: x, POSTGRES_DB: factoreye }
    volumes: ["pgdata:/var/lib/postgresql/data", "pgconf:/etc/pgbackrest", "pgrepo:/var/lib/pgbackrest"]
volumes: { pgdata: {}, pgconf: {}, pgrepo: {} }
Y
DC() { docker compose -f "$T/compose.yml" "$@"; }

# pgbackrest.conf を、ボリュームに作る（所有者 postgres、権限 600。本番と同じ）
grep -v '^repo1-s3-' "$HERE/pgbackrest.conf.example" \
  | sed -e 's#^repo1-type=.*#repo1-type=posix#' -e 's#^repo1-path=.*#repo1-path=/var/lib/pgbackrest#' -e 's#^process-max=.*#process-max=2#' \
  > "$T/pgbackrest.conf"
DC up -d --build postgres >/dev/null 2>&1 || fail "postgres のイメージを作れない"
DC cp "$T/pgbackrest.conf" postgres:/etc/pgbackrest/pgbackrest.conf >/dev/null 2>&1
DC exec -T -u root postgres sh -c 'chown postgres:postgres /etc/pgbackrest/pgbackrest.conf /var/lib/pgbackrest && chmod 600 /etc/pgbackrest/pgbackrest.conf'
export PG_SERVICE=postgres

# 1. 初期化（2 回実行しても安全）
step "$HERE/init.sh" || fail "init.sh が失敗"; ok "init.sh（ステンザ作成・アーカイブ有効・再起動・check）"
step "$HERE/init.sh" || fail "init.sh の 2 回目が失敗"; ok "init.sh を 2 回実行しても安全"
[ "$(DC exec -T -u postgres postgres psql -U factoreye -d factoreye -At -c 'show archive_mode')" = on ] || fail "archive_mode が on でない"

# 2. データ → 全体 → 追加 → 差分 → 追加 → WAL
SQLX() { DC exec -T -u postgres postgres psql -U factoreye -d factoreye -At -c "$1"; }
SQLX "create table t(id bigserial primary key, v double precision, ts timestamptz default now())" >/dev/null
SQLX "insert into t(v) select random() from generate_series(1,200000)" >/dev/null
step "$HERE/backup.sh" full || fail "backup.sh full が失敗"; ok "backup.sh full"
SQLX "insert into t(v) select random() from generate_series(1,100000)" >/dev/null
step "$HERE/backup.sh" diff || fail "backup.sh diff が失敗"; ok "backup.sh diff"
"$HERE/backup.sh" bogus >/dev/null 2>&1 && fail "不正な種類で成功してしまった"; ok "backup.sh は不正な種類を拒否する"
SQLX "insert into t(v) select random() from generate_series(1,50000)" >/dev/null
SQLX "select pg_switch_wal()" >/dev/null
EXPECT=$(SQLX "select count(*) from t")
sleep 5
step "$HERE/check.sh" || fail "check.sh（check と verify）が失敗"; ok "check.sh（check と verify）"

# 3. 復元: データのボリュームを空にして、ローカルの置き場から戻す。最新まで WAL を再生して、行数が一致すること
DC stop postgres >/dev/null 2>&1; DC rm -f postgres >/dev/null 2>&1; docker volume rm "${P}_pgdata" >/dev/null
DC run --rm --no-deps -u postgres --entrypoint pgbackrest postgres --stanza=factoreye restore >/dev/null 2>&1 || fail "pgbackrest restore が失敗"
DC up -d postgres >/dev/null 2>&1
for i in $(seq 1 90); do
  [ "$(DC exec -T -u postgres postgres psql -U factoreye -d factoreye -At -c 'select pg_is_in_recovery()' 2>/dev/null || echo x)" = f ] && break; sleep 2
done
GOT=$(SQLX "select count(*) from t")
[ "$GOT" = "$EXPECT" ] || fail "復元後の行数が違う（期待 $EXPECT、実際 $GOT）"
ok "復元（全体＋差分＋WAL の再生）で、行数が一致（$GOT 行）"
echo "すべて OK"
