#!/bin/bash
# init.sh・backup.sh・check.sh・monitor.sh と、復元（WAL の再生まで）を、ローカルの Docker で通して確かめる。R2 には送らない。
# 置き場は、S3 ではなく WAL-G のローカルのファイル置き場（WALG_FILE_PREFIX）。R2 との接続は、専用バケットで別に確認する（README.md）。
# 実行: infra/walg/test.sh   （Docker が要る。約 2〜3 分。終わると、コンテナとボリュームを消す）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
T="$(mktemp -d)"; P="walgtest$$"
export COMPOSE_PROJECT_NAME="$P" COMPOSE_FILE="$T/compose.yml" POSTGRES_USER=factoreye POSTGRES_DB=factoreye
cleanup() { docker compose -f "$T/compose.yml" --profile restore down -v >/dev/null 2>&1 || true; docker rmi "${P}-postgres" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
fail() { echo "NG: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
step() { local out; if ! out=$("$@" 2>&1); then echo "$out" | tail -20 >&2; return 1; fi; }

cat > "$T/compose.yml" <<Y
x-pg: &pg
  build: "$ROOT/infra/cloud/postgres"
  image: ${P}-postgres
  environment:
    POSTGRES_USER: factoreye
    POSTGRES_PASSWORD: x
    POSTGRES_DB: factoreye
    PGUSER: factoreye
    PGDATABASE: factoreye
    WALG_FILE_PREFIX: /var/lib/walg-repo
    WALG_COMPRESSION_METHOD: zstd
    WALG_DELTA_MAX_STEPS: "7"
services:
  postgres:
    <<: *pg
    volumes: ["pgdata:/var/lib/postgresql/data", "walgrepo:/var/lib/walg-repo"]
  rest:
    <<: *pg
    profiles: ["restore"]
    # 控えと同じ: アーカイブを止めて起動する
    command: ["postgres", "-c", "archive_mode=off"]
    volumes: ["pgdata:/var/lib/postgresql/data", "walgrepo:/var/lib/walg-repo"]
volumes: { pgdata: {}, walgrepo: {} }
Y
DC() { docker compose -f "$T/compose.yml" "$@"; }
export PG_SERVICE=postgres
DC up -d --build postgres >/dev/null 2>&1 || fail "postgres のイメージを作れない"
DC exec -T -u root postgres chown postgres:postgres /var/lib/walg-repo
SQLX() { DC exec -T -u postgres postgres psql -U factoreye -d factoreye -At -c "$1"; }
for _ in $(seq 1 60); do SQLX "select 1" >/dev/null 2>&1 && break; sleep 1; done

# 0. 設定が無いコンテナでは、init.sh が、わかりやすいエラーで止まる（別プロジェクトで確認する代わりに、変数を空にして呼ぶ）
OUT=$(PG_SERVICE=postgres bash -c 'source "$1/common.sh"; in_pg() { echo ""; }; need_walg_env' _ "$HERE" 2>&1 || true)
echo "$OUT" | grep -q 'WAL-G の設定がコンテナにありません' || fail "設定が無いときのエラーが出ない"; ok "設定が無いときは、わかりやすいエラーで止まる"

# 1. 初期化（2 回実行しても安全）
step "$HERE/init.sh" || fail "init.sh が失敗"; ok "init.sh（接続確認・archive 設定・再起動・WAL が届くか確認）"
step "$HERE/init.sh" || fail "init.sh の 2 回目が失敗"; ok "init.sh を 2 回実行しても安全"
[ "$(SQLX 'show archive_mode')" = on ] || fail "archive_mode が on でない"

# 2. データ → 全体 → 追加 → 差分 → 追加 → WAL
SQLX "create table t(id bigserial primary key, v double precision, ts timestamptz default now())" >/dev/null
SQLX "insert into t(v) select random() from generate_series(1,200000)" >/dev/null
step "$HERE/backup.sh" full || fail "backup.sh full が失敗"; ok "backup.sh full"
SQLX "insert into t(v) select random() from generate_series(1,100000)" >/dev/null
step "$HERE/backup.sh" delta || fail "backup.sh delta が失敗"; ok "backup.sh delta"
[ "$(DC exec -T -u postgres postgres wal-g backup-list 2>/dev/null | grep -c '^base_')" = 2 ] || fail "ベースバックアップが 2 つ（全体＋差分）でない"
"$HERE/backup.sh" bogus >/dev/null 2>&1 && fail "不正な種類で成功してしまった"; ok "backup.sh は不正な種類を拒否する"

# 3. monitor.sh: 正常なら成功。アーカイブが失敗し続けると、異常（終了コード 2）。直ると、回復する
step "$HERE/monitor.sh" || fail "monitor.sh が、正常なのに失敗"; ok "monitor.sh（正常）"
SQLX "alter system set archive_command = '/bin/false'" >/dev/null; SQLX "select pg_reload_conf()" >/dev/null
SQLX "insert into t(v) select random() from generate_series(1,1000)" >/dev/null; SQLX "select pg_switch_wal()" >/dev/null
DETECT=0; for _ in $(seq 1 45); do set +e; "$HERE/monitor.sh" >/dev/null 2>&1; RC=$?; set -e; [ "$RC" = 2 ] && { DETECT=1; break; }; sleep 2; done
[ "$DETECT" = 1 ] || fail "アーカイブの失敗を、monitor.sh が検知できない"; ok "monitor.sh（アーカイブの失敗を検知。終了コード 2）"
SQLX "alter system set archive_command = 'wal-g wal-push %p'" >/dev/null; SQLX "select pg_reload_conf()" >/dev/null
RECOVER=0; for _ in $(seq 1 60); do set +e; "$HERE/monitor.sh" >/dev/null 2>&1; RC=$?; set -e; [ "$RC" = 0 ] && { RECOVER=1; break; }; sleep 3; done
[ "$RECOVER" = 1 ] || fail "archive_command を直しても、monitor.sh が回復しない"; ok "monitor.sh（回復を確認）"

# 4. 追加 → WAL → check（backup-list と wal-verify）
SQLX "insert into t(v) select random() from generate_series(1,50000)" >/dev/null; SQLX "select pg_switch_wal()" >/dev/null
EXPECT=$(SQLX "select count(*) from t"); sleep 6
step "$HERE/check.sh" || fail "check.sh（backup-list と wal-verify）が失敗"; ok "check.sh（backup-list と wal-verify）"

# 5. 保持: 全体をもう一度取ると、古いバックアップ（全体＋差分）と、不要な WAL が削除され、全体 1 世代だけが残る
WAL_BEFORE=$(DC exec -T -u root postgres sh -c 'ls /var/lib/walg-repo/wal_005 | wc -l' | tr -d ' ')
step "$HERE/backup.sh" full || fail "2 回目の full が失敗"
N=$(DC exec -T -u postgres postgres wal-g backup-list 2>/dev/null | grep -c '^base_')
WAL_AFTER=$(DC exec -T -u root postgres sh -c 'ls /var/lib/walg-repo/wal_005 | wc -l' | tr -d ' ')
[ "$N" = 1 ] || fail "全体を 1 世代だけ残すはずが、バックアップが ${N} 個ある"
[ "$WAL_AFTER" -lt "$WAL_BEFORE" ] || fail "不要な WAL が削除されていない（${WAL_BEFORE} → ${WAL_AFTER}）"
ok "保持: 全体 1 世代だけが残り、不要な WAL が削除された（WAL ${WAL_BEFORE} → ${WAL_AFTER} 個）"
SQLX "insert into t(v) select random() from generate_series(1,30000)" >/dev/null; SQLX "select pg_switch_wal()" >/dev/null
EXPECT=$(SQLX "select count(*) from t"); sleep 6

# 6. 復元: データのボリュームを空にして、置き場から戻す。最新まで WAL を再生して、行数が一致すること
DC stop postgres >/dev/null 2>&1; DC rm -f postgres >/dev/null 2>&1; docker volume rm "${P}_pgdata" >/dev/null
DC run --rm --no-deps -u root --entrypoint sh postgres -c 'chown postgres:postgres /var/lib/postgresql/data /var/lib/walg-repo && gosu postgres wal-g backup-fetch /var/lib/postgresql/data LATEST && gosu postgres touch /var/lib/postgresql/data/recovery.signal && echo "restore_command = '"'"'wal-g wal-fetch %f %p'"'"'" >> /var/lib/postgresql/data/postgresql.auto.conf' >/dev/null 2>&1 || fail "backup-fetch が失敗"
DC --profile restore up -d rest >/dev/null 2>&1
for _ in $(seq 1 90); do [ "$(DC exec -T -u postgres rest psql -U factoreye -d factoreye -At -c 'select pg_is_in_recovery()' 2>/dev/null || echo x)" = f ] && break; sleep 2; done
GOT=$(DC exec -T -u postgres rest psql -U factoreye -d factoreye -At -c "select count(*) from t")
[ "$GOT" = "$EXPECT" ] || fail "復元後の行数が違う（期待 ${EXPECT}、実際 ${GOT}）"
ok "復元（全体＋WAL の再生）で、行数が一致（${GOT} 行）"
[ "$(DC exec -T -u postgres rest psql -U factoreye -d factoreye -At -c 'show archive_mode')" = off ] || fail "復元した DB で archive_mode が off でない"
ok "復元した DB は、アーカイブを止めて起動している"
echo "すべて OK"
