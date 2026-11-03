#!/usr/bin/env bash
# 本番の自動デプロイ（サーバーが、GitHub の main を 1 分ごとに見に行く方式）。
#
# 使い方: systemd のタイマー（factoreye-deploy.timer）が、1 分ごとに実行する。手で実行してもよい。
#   /opt/factoreye/infra/cloud/deploy-pull.sh
#
# 流れ: GitHub から最新を取得 → 前回デプロイした版から変わっていて、本番に関係するファイル
#       （backend/・frontend/・infra/cloud/・docker-compose.cloud.yml）が変わっていれば、
#       `docker compose up -d --build` で作り直す。それ以外（文書だけの変更など）は、コードを更新するだけ。
#
# なぜこの方式か: 以前は、本番サーバーに GitHub の自己ホスト型ランナーを置いていた。リポジトリを公開すると、
#   外部の人の PR の中身が、ランナー経由で本番サーバー上で実行される恐れがある（GitHub も公開リポジトリでの
#   使用を非推奨としている）。この方式は、サーバーから外へ見に行くだけで、外から入る口を開けない。
#   SSH の経路は、2026-10-06 のセキュリティ対応で閉じたので、戻さない。
#
# 守っていること:
#   - fast-forward だけで更新する。本番のコードが手元で書き換えられていたら、上書きせずに止まる（exit 1）
#   - デプロイの成功を記録する（.deployed）。失敗したら記録せず、次の回に、同じ版をもう一度試す
#   - 同時に 2 つは動かさない（ロック）
#   - main に入るのは、リポジトリの管理者が許可した変更だけ（ブランチ保護で担保する）
#
# 環境変数（通常は不要）: APP_DIR（既定 /opt/factoreye）、DEPLOY_BRANCH（main）、COMPOSE_FILE（docker-compose.cloud.yml）
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/factoreye}"
BRANCH="${DEPLOY_BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.cloud.yml}"
# これらのファイルが変わったときだけ、作り直す
WATCHED_PATHS='^(backend/|frontend/|infra/cloud/|docker-compose\.cloud\.yml$)'

# ログの時刻は日本時間（JST）にする
log() { echo "[$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M:%S') JST] $*"; }

cd "$APP_DIR"

# 同時に 2 回動かさない（長いビルドの途中に、次の回が始まらないように）。mkdir は、途中で切れない 1 回の操作
LOCK_DIR="$APP_DIR/.deploy.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "前回のデプロイがまだ動いています。今回は何もしません"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

git fetch --quiet origin "$BRANCH"
latest="$(git rev-parse "origin/$BRANCH")"

# 前回デプロイした版。記録が無い（初回）なら、今のコードが動いているものとして、そこから始める
STATE_FILE="$APP_DIR/.deployed"
if [ ! -f "$STATE_FILE" ]; then
  git rev-parse HEAD > "$STATE_FILE"
  log "初回: 今の版 $(cut -c1-7 "$STATE_FILE") を、デプロイ済みとして記録しました"
fi
deployed="$(cat "$STATE_FILE")"

if [ "$deployed" = "$latest" ]; then
  exit 0
fi

# fast-forward だけ。手元で書き換えられている・履歴が食い違っているときは、上書きせずに止まる
if ! git merge --ff-only --quiet "origin/$BRANCH"; then
  log "エラー: fast-forward できません（本番のコードが手元で変更されているか、履歴が食い違っています）。デプロイしません"
  exit 1
fi

if git diff --name-only "$deployed" "$latest" | grep -Eq "$WATCHED_PATHS"; then
  log "デプロイします: $(echo "$deployed" | cut -c1-7) → $(echo "$latest" | cut -c1-7)"
  docker compose -f "$COMPOSE_FILE" up -d --build
  log "デプロイが終わりました"
else
  log "本番に関係するファイルの変更はありません。コードだけ更新しました: $(echo "$latest" | cut -c1-7)"
fi

# 成功したときだけ記録する（失敗したら、次の回にもう一度試す）
echo "$latest" > "$STATE_FILE"
