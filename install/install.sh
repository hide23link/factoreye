#!/usr/bin/env bash
# FactorEye インストーラ（Ubuntu / Debian / Raspberry Pi OS 用）。
#
# 使い方（1 行）:
#   curl -fsSL https://raw.githubusercontent.com/hide23link/factoreye/main/install/install.sh | sudo bash
#
# やること:
#   1. Docker が無ければ導入する（公式の get.docker.com）
#   2. /opt/factoreye に compose ファイルと管理スクリプト（factoreye.sh）を置く
#   3. 設定ファイル config/.env を作る（鍵・パスワードは乱数。すでにあれば、そのまま残す）
#   4. 公開済みのイメージを取得して起動し、画面の URL と初期の管理パスワードを表示する
# もう一度実行すると、データと .env を残したまま更新する（更新前に DB のバックアップを取る）。
#
# 環境変数で変えられる項目（通常は不要）:
#   FACTOREYE_DIR       置き場所（既定 /opt/factoreye）
#   FACTOREYE_PORT      画面のポート（既定 3001）
#   FACTOREYE_VERSION   イメージの版（既定 latest）
#   FACTOREYE_BASE_URL  ファイルの取得元 URL（既定は GitHub の install/）
#   FACTOREYE_SRC_DIR   取得元をローカルのディレクトリにする（テスト用。curl の代わりに cp する）
#   FACTOREYE_IMAGE_PREFIX  イメージ名の前半（テスト用。既定 ghcr.io/hide23link）
#   FACTOREYE_SKIP_PULL     1 にするとイメージの取得を飛ばす（テスト用。手元でビルドしたイメージを使うとき）
#   FACTOREYE_HEALTH_HOST   起動確認で使うホスト名（テスト用。コンテナの中から実行するときに変える。既定 127.0.0.1）
set -euo pipefail

INSTALL_DIR="${FACTOREYE_DIR:-/opt/factoreye}"
PORT="${FACTOREYE_PORT:-3001}"
VERSION="${FACTOREYE_VERSION:-latest}"
BASE_URL="${FACTOREYE_BASE_URL:-https://raw.githubusercontent.com/hide23link/factoreye/main/install}"
SRC_DIR="${FACTOREYE_SRC_DIR:-}"
HEALTH_WAIT_SECONDS=120
HEALTH_HOST="${FACTOREYE_HEALTH_HOST:-127.0.0.1}"
IMAGE_PREFIX="${FACTOREYE_IMAGE_PREFIX:-ghcr.io/hide23link}"

say() { printf '%s\n' "$*"; }
die() { printf 'エラー: %s\n' "$*" >&2; exit 1; }

# 乱数の 16 進文字列。引数はバイト数（出力は 2 倍の文字数）。openssl が無い環境でも動くよう /dev/urandom を使う
random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

check_root() {
  [ "$(id -u)" -eq 0 ] || die "root 権限で実行してください。例: curl -fsSL <URL> | sudo bash"
}

check_os() {
  [ -r /etc/os-release ] || die "対応していない OS です（/etc/os-release がありません）"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian|raspbian) ;;
    *) say "注意: ${PRETTY_NAME:-不明な OS} は動作確認の対象外です。Docker が入っていれば続けます" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "対応していない CPU です（$(uname -m)）。対応: x86_64 / arm64（Raspberry Pi 4・5 の 64bit OS）" ;;
  esac
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    say "Docker を導入します（公式の get.docker.com を使います。数分かかります）..."
    command -v curl >/dev/null 2>&1 || { apt-get update -q && apt-get install -y -q curl ca-certificates; }
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 \
    || die "docker compose（v2）が使えません。Docker を最新版にしてください: https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "Docker が起動していません。'systemctl start docker' を試してください"
}

# 取得元から 1 ファイルを置く。ローカルのディレクトリ指定ならコピー、無ければダウンロード
fetch_file() {
  local name="$1" mode="$2"
  if [ -n "$SRC_DIR" ]; then
    cp "$SRC_DIR/$name" "$INSTALL_DIR/$name"
  else
    curl -fsSL "$BASE_URL/$name" -o "$INSTALL_DIR/$name.tmp" || die "$name を取得できません（$BASE_URL/$name）"
    mv "$INSTALL_DIR/$name.tmp" "$INSTALL_DIR/$name"
  fi
  chmod "$mode" "$INSTALL_DIR/$name"
}

# この PC の LAN 内 IP。取れなければ localhost
detect_ip() {
  local ip=""
  ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')" || true
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  printf '%s' "${ip:-localhost}"
}

# 画面の初期パスワード用に、bcrypt のハッシュを作る。backend のイメージの中の bcrypt を使う
# （パスワードは環境変数で渡す。コマンドラインに出すと ps で他人に見えるため）
hash_password() {
  docker run --rm -e FACTOREYE_PW="$1" --entrypoint python \
    "${IMAGE_PREFIX}/factoreye-backend:$VERSION" \
    -c 'import bcrypt, os; print(bcrypt.hashpw(os.environ["FACTOREYE_PW"].encode(), bcrypt.gensalt()).decode())'
}

# 新規インストール用に .env を作る。作ったら、初期パスワードを ADMIN_PASSWORD に入れる（画面に 1 度だけ表示するため）
create_env() {
  local ip="$1" ingest_key jwt_secret db_password content
  ingest_key="$(random_hex 24)"
  jwt_secret="$(random_hex 32)"
  db_password="$(random_hex 16)"
  ADMIN_PASSWORD="$(random_hex 2)-$(random_hex 2)-$(random_hex 2)"
  local hash
  hash="$(hash_password "$ADMIN_PASSWORD")" || die "管理パスワードのハッシュを作れません"

  content="$(cat "$INSTALL_DIR/.env.template")"
  # 先に DATABASE_URL の行（パスワードを含む）を置き換えてから、残りの __GENERATE__ を順に置き換える
  content="${content//postgresql+asyncpg:\/\/factoreye:__GENERATE__@/postgresql+asyncpg://factoreye:${db_password}@}"
  content="${content/INGEST_API_KEY=__GENERATE__/INGEST_API_KEY=${ingest_key}}"
  content="${content/JWT_SECRET=__GENERATE__/JWT_SECRET=${jwt_secret}}"
  content="${content/POSTGRES_PASSWORD=__GENERATE__/POSTGRES_PASSWORD=${db_password}}"
  # ハッシュは $ を含む。docker compose が展開しないよう、単一引用符で囲む
  content="${content/ADMIN_PASSWORD_HASH=/ADMIN_PASSWORD_HASH=\'${hash}\'}"
  content="${content/FRONTEND_URL=http:\/\/localhost:3001/FRONTEND_URL=http://${ip}:${PORT}}"
  content="${content/FACTOREYE_PORT=3001/FACTOREYE_PORT=${PORT}}"
  content="${content/FACTOREYE_VERSION=latest/FACTOREYE_VERSION=${VERSION}}"
  # コメント行は除いて、置き換え漏れがないか調べる
  if printf '%s\n' "$content" | grep -v '^#' | grep -q '__GENERATE__'; then die ".env の生成に失敗しました（未置換の項目があります）"; fi

  (umask 077 && printf '%s\n' "$content" > "$INSTALL_DIR/config/.env")
}

# 毎日 3 時にバックアップを取る（cron.d がある環境だけ）
install_backup_cron() {
  [ -d /etc/cron.d ] || return 0
  printf '0 3 * * * root %s/factoreye.sh backup >> %s/backups/backup.log 2>&1\n' "$INSTALL_DIR" "$INSTALL_DIR" \
    > /etc/cron.d/factoreye
  chmod 644 /etc/cron.d/factoreye
}

wait_for_health() {
  local waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_SECONDS" ]; do
    if curl -fsS "http://${HEALTH_HOST}:${PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

main() {
  check_root
  check_os
  ensure_docker

  mkdir -p "$INSTALL_DIR/backups" "$INSTALL_DIR/config"
  cd "$INSTALL_DIR"
  local is_update=false
  [ -f config/.env ] && is_update=true

  fetch_file docker-compose.yml 644
  fetch_file .env.template 644
  fetch_file factoreye.sh 755

  if [ "$is_update" = true ]; then
    say "既存の設定（.env）とデータを残して更新します"
    # 更新前に DB を退避する。DB が動いていなければ（初回の失敗後など）飛ばす
    ./factoreye.sh backup || say "注意: 更新前のバックアップを取れませんでした（DB が停止中の可能性）。続けます"
  fi

  # 管理パスワードのハッシュ作りで backend のイメージを使うため、新規のときは、取得より先に .env を作る
  # （イメージが手元に無ければ、docker run が自動で取得する）
  ADMIN_PASSWORD=""
  if [ "$is_update" = false ]; then
    create_env "$(detect_ip)"
  fi

  if [ "${FACTOREYE_SKIP_PULL:-}" != "1" ]; then
    say "イメージを取得します..."
    docker compose --env-file config/.env pull
  fi

  docker compose --env-file config/.env up -d
  install_backup_cron

  say "起動を待っています（最大 ${HEALTH_WAIT_SECONDS} 秒）..."
  wait_for_health || die "起動を確認できません。'cd $INSTALL_DIR && ./factoreye.sh logs' で原因を確認してください"

  local url
  url="http://$(detect_ip):${PORT}"
  say ""
  say "=========================================="
  say " FactorEye が起動しました"
  say "   画面: ${url}"
  if [ -n "$ADMIN_PASSWORD" ]; then
    say "   管理パスワード（設定画面の変更に必要。今回だけ表示します。必ず控えてください）:"
    say "     ${ADMIN_PASSWORD}"
  else
    say "   既存の設定を引き継ぎました。管理パスワードを変えるには: cd $INSTALL_DIR && ./factoreye.sh set-password"
  fi
  say "   設定ファイル: $INSTALL_DIR/config/.env"
  say "   管理コマンド: cd $INSTALL_DIR && ./factoreye.sh   （update / backup / status / logs / set-password）"
  say "=========================================="
}

# 関数をすべて読み込んでから実行する（curl の途中で切れた、不完全なスクリプトを実行しないため）
main "$@"
