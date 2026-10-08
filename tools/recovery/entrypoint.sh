#!/bin/bash
# 作業用の Postgres（バックアップの展開先）を起動してから、Web 画面を起動する。
# 作業用の Postgres は外から接続できないよう、TCP で待ち受けずソケットだけにする。
set -euo pipefail

DATA="${SCRATCH_PGDATA:-/var/lib/recovery/pg}"
SOCK=/tmp/recovery-pg

if [ -z "${SCRATCH_DSN:-}" ]; then
  if [ ! -s "$DATA/PG_VERSION" ]; then
    initdb --auth=trust --username=recovery --encoding=UTF8 --locale=C.UTF-8 -D "$DATA" > /dev/null
  fi
  mkdir -p "$SOCK"
  pg_ctl -D "$DATA" -l /var/lib/recovery/scratch-pg.log -w \
    -o "-c listen_addresses='' -k $SOCK" start
  export SCRATCH_DSN="postgresql://recovery@/postgres?host=$SOCK"
fi

exec uvicorn --factory recovery.main:build --host 0.0.0.0 --port 8090 --no-server-header
