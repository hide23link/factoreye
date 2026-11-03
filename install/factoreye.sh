#!/usr/bin/env bash
# FactorEye の管理コマンド（install.sh が /opt/factoreye に置く）。
#
# 使い方: ./factoreye.sh <コマンド>
#   status        各コンテナの状態を表示する
#   logs [名前]   ログを表示する（例: ./factoreye.sh logs backend）
#   restart       設定ファイル（config/.env）を直接編集したあとに、反映する
#   update        DB をバックアップしてから、最新のイメージに更新する
#   backup        DB と設定ファイルをバックアップする（backups/ に 7 日分を残す）
#   set-password  管理パスワード（設定画面の変更に必要）を決め直す
#   restore-env   画面で保存する前の設定（config/.env.bak）に戻す
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
ENV_FILE="config/.env"

# 設定ファイル（config/.env）を compose の変数（ポート・DB パスワード・版）にも使う
compose() { docker compose --env-file "$ENV_FILE" "$@"; }

die() { printf 'エラー: %s\n' "$*" >&2; exit 1; }

# .env の KEY=値 の行を書き換える（無ければ末尾に足す）。
# 権限・所有者を変えないよう、新しいファイルで置き換えず、同じファイルへ上書きする
set_env_value() {
  local key="$1" value="$2" updated
  updated="$(KEY="$key" VALUE="$value" awk '
    BEGIN { found = 0 }
    index($0, ENVIRON["KEY"] "=") == 1 { print ENVIRON["KEY"] "=" ENVIRON["VALUE"]; found = 1; next }
    { print }
    END { if (!found) print ENVIRON["KEY"] "=" ENVIRON["VALUE"] }
  ' "$ENV_FILE")"
  cp "$ENV_FILE" "$ENV_FILE.bak"
  printf '%s\n' "$updated" > "$ENV_FILE"
}

cmd_backup() {
  mkdir -p backups
  local file="backups/factoreye-$(date +%Y%m%d-%H%M%S).sql.gz"
  # 途中で失敗した壊れたファイルを残さないよう、完了してから名前を付ける
  if ! compose exec -T postgres pg_dump -U factoreye factoreye | gzip > "$file.partial"; then
    rm -f "$file.partial"
    die "バックアップに失敗しました（DB が停止中の可能性があります）"
  fi
  mv "$file.partial" "$file"
  # 設定ファイル（鍵・DB パスワード）も一緒に残す。失うと、DB のバックアップだけでは元に戻せない
  (umask 077 && cp "$ENV_FILE" "${file%.sql.gz}.env")
  # umask だけに頼らず、権限を明示する（置き場所の既定の ACL で広がることがあるため）
  chmod 600 "$file" "${file%.sql.gz}.env"
  find backups \( -name 'factoreye-*.sql.gz' -o -name 'factoreye-*.env' \) -mtime "+$BACKUP_RETENTION_DAYS" -delete
  echo "バックアップしました: ${file}（設定ファイルは ${file%.sql.gz}.env）"
}

cmd_update() {
  cmd_backup
  compose pull
  compose up -d
  echo "更新しました。確認: ./factoreye.sh status"
}

cmd_set_password() {
  local password confirm hash
  [ -t 0 ] || [ -r /dev/tty ] || die "対話できる端末で実行してください"
  read -r -s -p "新しい管理パスワード（6 文字以上）: " password < /dev/tty; echo
  [ "${#password}" -ge 6 ] || die "6 文字以上にしてください"
  read -r -s -p "もう一度: " confirm < /dev/tty; echo
  [ "$password" = "$confirm" ] || die "一致しません"
  # パスワードは環境変数で渡す（コマンドラインに出すと ps で他人に見えるため）
  hash="$(compose run --rm -T -e FACTOREYE_PW="$password" --no-deps --entrypoint python backend \
    -c 'import bcrypt, os; print(bcrypt.hashpw(os.environ["FACTOREYE_PW"].encode(), bcrypt.gensalt()).decode())')"
  # $ を含むので、単一引用符で囲む（compose の変数展開を避ける）
  set_env_value ADMIN_PASSWORD_HASH "'${hash}'"
  compose restart backend
  echo "管理パスワードを変更しました"
}

cmd_restore_env() {
  [ -f "$ENV_FILE.bak" ] || die "$ENV_FILE.bak がありません"
  cat "$ENV_FILE.bak" > "$ENV_FILE"
  compose restart backend
  echo ".env を直前の内容に戻しました"
}

case "${1:-}" in
  status)       compose ps ;;
  logs)         shift; compose logs --tail 200 -f "$@" ;;
  restart)      compose restart backend ;;
  update)       cmd_update ;;
  backup)       cmd_backup ;;
  set-password) cmd_set_password ;;
  restore-env)  cmd_restore_env ;;
  *)            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
