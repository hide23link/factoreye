#!/bin/bash
# PostgreSQLの日次バックアップ（docs/architecture.md §11 運用（バックアップ） に準拠）。
# 本番運用者がcronで `0 3 * * * /path/to/factoreye/infra/backup.sh` のように毎日3時に実行する想定。
# コンテナ名を直接指定せず `docker compose exec <service名>` を使うことで、
# compose project名（ディレクトリ名）がホストによって変わっても動作する。
#
# 作るもの（すべて $BACKUP_DIR に置き、保持期間を過ぎたら削除する）:
#   factoreye-<日時>.sql.gz                    DB 全体（pg_dump）
#   factoreye-<日時>.sql.gz.sha256             破損・改ざんの確認用（tools/recovery が検証する）
#   factoreye-<日時>-config.tar.gz.enc         .env・管理者ファイルなど（暗号化。BACKUP_PASSPHRASE_FILE を設定した場合だけ）
#   factoreye-<日時>-config.tar.gz.enc.sha256
# OFFSITE_S3_URI を設定すると、作ったファイルを infra/offsite-s3.sh で S3 にも送る。
# BACKUP_DB=off にすると、DB のダンプを取らず、設定ファイルのバックアップだけを作る（既定は on）。
#   クラウド版は DB のバックアップを WAL-G（WAL の追記＋ベース）で R2 に送るため、毎晩のダンプはやめた（infra/walg/README.md）。
#   設定ファイルのバックアップは、DR の控えの起動に必要なので、残す。
set -euo pipefail

# このスクリプトの場所からリポジトリルート（docker-compose.ymlがある場所）を特定する
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-factoreye}"
POSTGRES_USER="${POSTGRES_USER:-factoreye}"
# 設定ファイルの暗号化に使う合言葉のファイル。未設定なら設定ファイルは保存しない（DB だけ取る）
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"
# 保存する設定ファイル（空白区切り。相対パスはリポジトリ直下から。無いものは飛ばす）。
# どれも DB に入っていないため、プログラムを壊されたときに DB だけ戻しても復旧できない
BACKUP_CONFIG_FILES="${BACKUP_CONFIG_FILES:-.env admin/admins.txt /etc/cloudflared/config.yml}"
OFFSITE_S3_URI="${OFFSITE_S3_URI:-}"
# on: DB のダンプ（pg_dump）＋設定ファイル。off: 設定ファイルだけ（BACKUP_PASSPHRASE_FILE が必須）
BACKUP_DB="${BACKUP_DB:-on}"
case "$BACKUP_DB" in on|off) ;; *) echo "エラー: BACKUP_DB は on か off です（今: ${BACKUP_DB}）" >&2; exit 1 ;; esac
if [ "$BACKUP_DB" = "off" ] && [ -z "$BACKUP_PASSPHRASE_FILE" ]; then
  echo "エラー: BACKUP_DB=off のときは、BACKUP_PASSPHRASE_FILE が必要です（設定ファイルだけを保存するため）" >&2
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/factoreye-$TIMESTAMP.sql.gz"
CONFIG_DEST="$BACKUP_DIR/factoreye-$TIMESTAMP-config.tar.gz.enc"
# 書き込み中は factoreye-* に当たらない名前にしておき、書き終えてから名前を変える。
# 書きかけのファイルを、外部への取得（offsite-pull.sh）や復旧ツールが拾わないように
PARTIAL="$BACKUP_DIR/.partial-factoreye-$TIMESTAMP.sql.gz"
CONFIG_PARTIAL="$BACKUP_DIR/.partial-factoreye-$TIMESTAMP-config.tar.gz.enc"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# sha256sum の形式（"<hex>  <ファイル名>"）でファイルの隣に書く。ファイル名だけを書くため、
# 別の場所（S3・ラズパイ）に移しても `sha256sum -c` で確かめられる
write_checksum() {
  (cd "$(dirname "$1")" && sha256sum "$(basename "$1")" > "$(basename "$1").sha256")
}

backup_config_files() {
  if [ -z "$BACKUP_PASSPHRASE_FILE" ]; then
    log "設定ファイルの保存は省略します（BACKUP_PASSPHRASE_FILE が未設定）"
    return 0
  fi
  if [ ! -r "$BACKUP_PASSPHRASE_FILE" ]; then
    log "エラー: 合言葉のファイルを読めません: $BACKUP_PASSPHRASE_FILE"
    return 1
  fi

  local targets=() f abs
  for f in $BACKUP_CONFIG_FILES; do
    case "$f" in
      /*) abs="$f" ;;
      *) abs="$REPO_ROOT/$f" ;;
    esac
    if [ -f "$abs" ]; then
      # tar -C / で絶対パスのまま収める（展開したときに元の場所が分かるように）
      targets+=("${abs#/}")
    else
      log "設定ファイルが無いため飛ばします: $abs"
    fi
  done
  if [ ${#targets[@]} -eq 0 ]; then
    log "保存する設定ファイルがありません"
    return 0
  fi

  # .env には DB のパスワードや JWT の鍵が入るため、暗号化してから置く（外部の保管先に平文で出さない）
  if ! tar -czf - -C / "${targets[@]}" \
      | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
          -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$CONFIG_PARTIAL"; then
    log "エラー: 設定ファイルの保存に失敗しました"
    rm -f "$CONFIG_PARTIAL"
    return 1
  fi
  mv "$CONFIG_PARTIAL" "$CONFIG_DEST"
  write_checksum "$CONFIG_DEST"
  log "設定ファイルを保存しました: ${CONFIG_DEST}（${#targets[@]} 件）"
}

# バックアップには利用者のデータとパスワードのハッシュが入るため、ほかの利用者には読ませない（640）。
# グループには読ませる: 復旧ツール（tools/recovery）は root 以外の利用者で動き、root のグループで読むため
umask 027
mkdir -p "$BACKUP_DIR"

if [ "$BACKUP_DB" = "on" ]; then
  log "バックアップ開始: $DEST"

  # -T: ttyを確保しない（cron等の非対話実行でpg_dumpの出力がTTY制御文字で壊れるのを防ぐ）
  if ! docker compose exec -T "$POSTGRES_SERVICE" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$PARTIAL"; then
    log "エラー: pg_dumpに失敗しました"
    rm -f "$PARTIAL"
    exit 1
  fi

  if [ ! -s "$PARTIAL" ]; then
    log "エラー: バックアップファイルが空です（${DEST}）"
    rm -f "$PARTIAL"
    exit 1
  fi

  mv "$PARTIAL" "$DEST"
  write_checksum "$DEST"
  log "バックアップ完了: $DEST ($(du -h "$DEST" | cut -f1))"
else
  log "DB のダンプは取りません（BACKUP_DB=off。DB は WAL-G で R2 へ）。設定ファイルだけを保存します"
fi

# 設定ファイル・外部保管に失敗しても、DB のバックアップと保持期間の削除は続ける。
# 失敗は最後に終了コードで知らせる（cron のログで気づけるように）
status=0
backup_config_files || status=1

if [ -n "$OFFSITE_S3_URI" ]; then
  uploads=()
  if [ "$BACKUP_DB" = "on" ]; then
    uploads+=("$DEST" "$DEST.sha256")
  fi
  if [ -f "$CONFIG_DEST" ]; then
    uploads+=("$CONFIG_DEST" "$CONFIG_DEST.sha256")
  fi
  if [ "${#uploads[@]}" -gt 0 ]; then
    "$REPO_ROOT/infra/offsite-s3.sh" "${uploads[@]}" || status=1
  else
    log "外部へ送るファイルがありません（設定ファイルの保存に失敗したか、対象がない）"
    status=1
  fi
fi

log "保持期間（${RETENTION_DAYS}日）を過ぎたバックアップを削除します"
find "$BACKUP_DIR" -maxdepth 1 -type f -name "factoreye-*" -mtime "+$RETENTION_DAYS" -print -delete

if [ "$status" -ne 0 ]; then
  log "完了（一部に失敗あり。上のエラーを確認してください）"
  exit "$status"
fi
log "完了"
