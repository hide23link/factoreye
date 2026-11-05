#!/bin/bash
# readings の主キー統合（マイグレーション g7b8c9d0e1f2）の前に、DB のディスクの空きが足りるかを確かめる。
# 移行は readings を新しいテーブルへ写してから旧テーブルを消すので、一時的に両方と、その分の WAL・
# 並べ替えの一時ファイルが要る。空きが足りないまま始めると、途中でディスクが一杯になり、DB が止まる
# （移行は 1 つのトランザクションなので旧データは残るが、空きを作るまで DB が起動しない）。
#
# 【誰が・いつ実行するか】運用者が、このマイグレーションを含む版へ更新する前（アプリを止める前）に、
# リポジトリのある場所で 1 回実行する。引数はない。
#   ./infra/check-migration-space.sh
# 終了コード: 0 = 足りる（または移行済みで確認不要）、1 = 足りない、2 = 確かめられない（DB が動いていないなど）。
#
# 必要な空きの目安は、readings（索引を含む）の 2 倍。実測（500 万行）では、新しいテーブルが旧の約 0.6 倍
# （766 MB → 481 MB）。これに、同じくらいの WAL と、並べ替え（DISTINCT ON）の一時ファイルが加わるため、
# 余裕を持たせた（WAL と一時ファイルの大きさは測っていない）。
# コンテナ名を直接指定せず `docker compose exec <service名>` を使う（backup.sh と同じ）。
# クラウド版は COMPOSE_FILE=docker-compose.cloud.yml を付けて実行する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-factoreye}"
POSTGRES_USER="${POSTGRES_USER:-factoreye}"
# readings の大きさに掛ける倍率（上の目安）
SPACE_FACTOR=2

psql_value() {
  docker compose exec -T "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"
}

if ! version="$(psql_value "SELECT version_num FROM alembic_version")"; then
  echo "確かめられません: DB に接続できないか、スキーマの版が読めません（docker compose で ${POSTGRES_SERVICE} が動いているか、COMPOSE_FILE が合っているかを確かめてください）" >&2
  exit 2
fi
# readings に id 列が無ければ、移行は済んでいる
has_id="$(psql_value "SELECT count(*) FROM information_schema.columns WHERE table_name = 'readings' AND column_name = 'id'")"
if [ "$has_id" = "0" ]; then
  echo "移行済みです（スキーマの版: ${version}）。確認は要りません"
  exit 0
fi

readings_bytes="$(psql_value "SELECT pg_total_relation_size('readings')")"
data_dir="$(psql_value "SHOW data_directory")"
# df -Pk の 4 列目が、使える空き（KB）
free_kb="$(docker compose exec -T "$POSTGRES_SERVICE" df -Pk "$data_dir" | awk 'NR == 2 { print $4 }')"
free_bytes=$((free_kb * 1024))
need_bytes=$((readings_bytes * SPACE_FACTOR))

to_mb() { echo $(($1 / 1024 / 1024)); }
echo "readings の大きさ: $(to_mb "$readings_bytes") MB"
echo "必要な空き（目安、${SPACE_FACTOR} 倍）: $(to_mb "$need_bytes") MB"
echo "DB のディスクの空き: $(to_mb "$free_bytes") MB（${data_dir}）"
if [ "$free_bytes" -lt "$need_bytes" ]; then
  echo "空きが足りません。古い測定値を消すか、ディスクを広げてから更新してください" >&2
  exit 1
fi
echo "足ります。バックアップを取ってから、アプリを止めて更新してください（infra/README.md）"
