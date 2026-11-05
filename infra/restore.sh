#!/bin/bash
# infra/backup.sh で作成したバックアップから復元する。
#
# 前提・制約（安全のため意図的にシンプルにしている）:
# - バックアップは`pg_dump`の素のSQL（--clean無し）のため、空のDBへの復元のみを想定する。
#   データが残っているDBに対して実行すると「オブジェクトが既に存在する」エラーで失敗する
#   （黙って上書き・混在させることはない。本番データが入ったDBへの復元が必要な場合は、
#   事前にそのDB/ボリュームを作り直してから本スクリプトを実行すること）。
# - 確認なしに即実行されると事故の元なので、対象ファイルの明示と`--yes`相当の確認を必須にする。
# - ON_ERROR_STOP で、どれか1行でも失敗したら即座に止める（黙って一部だけ復元しない）。
#   復旧ツール用の読み取り専用ロール（factoreye_readonly）への GRANT がバックアップに
#   含まれるが、復元先にそのロールが無いと失敗するため、無ければ（ログイン不可で）先に作る
#   （実機の復元訓練で判明。パスワードは別途 tools/recovery/README.md の手順で設定し直すこと）
set -euo pipefail

usage() {
  echo "使い方: $0 <バックアップファイル.sql.gz>" >&2
  exit 1
}

[ $# -eq 1 ] || usage
BACKUP_FILE="$1"
[ -f "$BACKUP_FILE" ] || { echo "エラー: ファイルが見つかりません: $BACKUP_FILE" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-factoreye}"
POSTGRES_USER="${POSTGRES_USER:-factoreye}"

echo "復元先: service=$POSTGRES_SERVICE db=$POSTGRES_DB (このDBは空である必要があります)"
echo "復元元: $BACKUP_FILE"
read -r -p "本当に復元を実行しますか？ [y/N] " REPLY
case "$REPLY" in
  y|Y) ;;
  *) echo "中止しました"; exit 1 ;;
esac

echo "読み取り専用ロール（factoreye_readonly）が無ければ作成します（ログイン不可の状態で）"
docker compose exec -T "$POSTGRES_SERVICE" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'factoreye_readonly') THEN
    CREATE ROLE factoreye_readonly NOLOGIN;
  END IF;
END $$;
SQL

gunzip -c "$BACKUP_FILE" \
  | docker compose exec -T "$POSTGRES_SERVICE" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"

echo "復元完了"
echo "注意: factoreye_readonly はログイン不可の状態です。復旧ツールで使う場合は"
echo "  tools/recovery/README.md の「読み取り専用のロール」の手順でパスワードを設定してください。"
