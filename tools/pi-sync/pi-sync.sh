#!/usr/bin/env bash
# ラズパイの DB から、ローカルの Docker の DB へ、実データ（設定と測定値）を取り込む（開発用・読み取りだけ）。
#
# 使い方（リポジトリのどこからでも。接続先は --pi か環境変数 PI_SSH で必ず渡す）:
#   tools/pi-sync/pi-sync.sh --pi user@raspberrypi.local   # 1 回だけ追いつく（初回は直近 1 日分）
#   PI_SSH=user@raspberrypi.local tools/pi-sync/pi-sync.sh  # 環境変数で渡しても同じ
#   tools/pi-sync/pi-sync.sh --days 7        # 初回に取り込む日数（1〜30）
#   tools/pi-sync/pi-sync.sh --follow [秒]   # 追いついたあと、数秒ごとに新しい分を足し続ける（Ctrl+C で終了）
#   tools/pi-sync/pi-sync.sh --reset-config  # 機器・センサー・ダッシュボードを、ラズパイの内容で丸ごと置き換える
#   tools/pi-sync/pi-sync.sh --status        # ラズパイとローカルの件数・最新時刻だけ見る
#
# 接続先（どちらか必須。両方あれば --pi が優先）:
#   --pi <ユーザー@ホスト>  ssh の接続先（例: user@raspberrypi.local、user@<Tailscale の名前>）
#   PI_SSH        同上を環境変数で渡すとき
# 環境変数（任意）:
#   PI_CONTAINER  ラズパイの Postgres のコンテナ名（既定 factoreye-postgres-1）
#
# 安全のため:
# - ラズパイには、読み取り専用のセッション（default_transaction_read_only=on）で COPY するだけ。書き込みはしない。
# - 機器キーのハッシュは持ち込まず、ローカル用の値に置き換える。通知・Webhook・ユーザーの設定も持ち込まない
#   （ローカルから本物の通知が出ないようにするため）。
# - 既定では、ローカルに無い機器・センサー・ダッシュボードだけを足す（ローカルで作った試験用の設定を消さない）。
# - ローカルの測定値は、取り込む日数より古い分を消す（ローカルの DB が大きくならないように）。
set -euo pipefail

PI_SSH="${PI_SSH:-}"
PI_CONTAINER="${PI_CONTAINER:-factoreye-postgres-1}"
DAYS=1
FOLLOW=""
RESET_CONFIG=0
STATUS_ONLY=0
# 設定の表（外部キーの親から順）。通知・Webhook・ユーザーは含めない
CONFIG_TABLES="ingest_devices sensors dashboards widgets alarms"

while [ $# -gt 0 ]; do
  case "$1" in
    --pi) PI_SSH="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    --days) DAYS="${2:-}"; shift 2 ;;
    --follow)
      FOLLOW=5
      if [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]]; then FOLLOW="$2"; shift; fi
      shift ;;
    --reset-config) RESET_CONFIG=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) sed -n 2,23p "$0"; exit 0 ;;
    *) echo "不明な引数: $1（--help で使い方）" >&2; exit 2 ;;
  esac
done
# 接続先は人ごとに違うので、既定値を持たない（書いておくと、使う人の環境と合わないまま ssh してしまう）
if [ -z "$PI_SSH" ]; then
  echo "ラズパイの接続先が指定されていません。--pi user@host か、環境変数 PI_SSH=user@host で渡してください（--help で使い方）" >&2; exit 2
fi
if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || [ "$DAYS" -lt 1 ] || [ "$DAYS" -gt 30 ]; then
  echo "--days は 1〜30 の整数で指定してください（指定: ${DAYS}）" >&2; exit 2
fi

cd "$(dirname "$0")/../.."

SSH_OPTS=(-C -o BatchMode=yes -o ConnectTimeout=8 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-pisync-%C" -o ControlPersist=120)
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

# ラズパイの Postgres に、読み取り専用で SQL を流す（標準入力の SQL を実行し、結果を標準出力へ）
remote_psql() {
  ssh "${SSH_OPTS[@]}" "$PI_SSH" "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' $PI_CONTAINER sh -c 'exec psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -At -q'"
}
# ローカルの Postgres（docker compose の postgres）に SQL を流す
local_psql() {
  docker compose exec -T postgres psql -U factoreye -d factoreye -v ON_ERROR_STOP=1 -At -q
}

now_jst() { TZ=Asia/Tokyo date '+%H:%M:%S'; }

check_ready() {
  if ! docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
    echo "ローカルの postgres が起動していません。先に: docker compose up -d postgres backend" >&2; return 1
  fi
  local pi_ver local_ver
  pi_ver="$(echo "SELECT version_num FROM alembic_version;" | remote_psql)" || { echo "ラズパイに接続できません（PI_SSH=${PI_SSH}）" >&2; return 1; }
  local_ver="$(echo "SELECT version_num FROM alembic_version;" | local_psql 2>/dev/null || true)"
  if [ -z "$local_ver" ]; then
    echo "ローカルの DB にまだ表がありません。先にバックエンドを起動してください（docker compose up -d backend）" >&2; return 1
  fi
  if [ "$pi_ver" != "$local_ver" ]; then
    echo "DB のバージョンが違います（ラズパイ: $pi_ver / ローカル: ${local_ver}）。ブランチを合わせて、バックエンドを起動し直してください。" >&2; return 1
  fi
}

# 設定の表を取り込む。既定は「ローカルに無い行だけ足す」。--reset-config は丸ごと置き換える
sync_config() {
  local t
  {
    echo "BEGIN;"
    if [ "$RESET_CONFIG" = 1 ]; then
      echo "SET LOCAL session_replication_role = replica;"
      # 測定値も消す（センサーが入れ替わるので、古い測定値が残ると、どのセンサーにも属さなくなる）
      echo "DELETE FROM readings; DELETE FROM readings_rollup;"
      for t in $CONFIG_TABLES; do echo "DELETE FROM $t;"; done
    fi
    for t in $CONFIG_TABLES; do
      echo "CREATE TEMP TABLE _in_$t (LIKE $t INCLUDING DEFAULTS) ON COMMIT DROP;"
      echo "COPY _in_$t FROM STDIN;"
      echo "COPY (SELECT * FROM $t) TO STDOUT;" | remote_psql
      echo '\.'
      echo "INSERT INTO $t SELECT * FROM _in_$t ON CONFLICT DO NOTHING;"
    done
    # 機器キーのハッシュは持ち込まない（ローカル用の値に置き換える。ローカルから取り込みの認証には使えない）
    echo "UPDATE ingest_devices SET key_hash = encode(sha256(convert_to(id::text, 'UTF8')), 'hex') WHERE key_hash <> encode(sha256(convert_to(id::text, 'UTF8')), 'hex');"
    echo "COMMIT;"
  } > "$TMP_FILE"
  if ! local_psql < "$TMP_FILE" > /dev/null; then
    echo "設定の取り込みに失敗しました。ローカルに、同じ名前で別の機器・センサーがあるときは、--reset-config（ラズパイの内容で置き換え）を使ってください。" >&2
    return 1
  fi
}

# 測定値（readings）と 1 分まとめ（readings_rollup）の、まだ無い分を取り込む
sync_readings() {
  local since n_read n_roll
  echo "DELETE FROM readings WHERE recorded_at < now() - interval '$DAYS days'; DELETE FROM readings_rollup WHERE bucket_start < now() - interval '$DAYS days';" | local_psql > /dev/null
  since="$(echo "SELECT GREATEST(max(recorded_at) - interval '1 minute', now() - interval '$DAYS days') FROM readings;" | local_psql)"
  if ! [[ "$since" =~ ^[0-9:+.\ -]+$ ]]; then echo "取り込みの開始時刻を決められません: $since" >&2; return 1; fi

  # 測定値: 1 分ずらして重ねて取り（遅れて届いた分も拾う）、同じ (センサー, 時刻) は無視する
  echo "COPY (SELECT * FROM readings WHERE recorded_at >= timestamptz '$since') TO STDOUT;" | remote_psql > "$TMP_FILE.r"
  n_read="$({
    echo "BEGIN; CREATE TEMP TABLE _in_r (LIKE readings INCLUDING DEFAULTS) ON COMMIT DROP; COPY _in_r FROM STDIN;"
    cat "$TMP_FILE.r"; echo '\.'
    echo "WITH ins AS (INSERT INTO readings SELECT * FROM _in_r ON CONFLICT DO NOTHING RETURNING 1) SELECT count(*) FROM ins; COMMIT;"
  } | local_psql | tail -1)"

  # 1 分まとめ: 遅れて届いた値で更新されることがあるので、上書きする
  echo "COPY (SELECT * FROM readings_rollup WHERE bucket_start >= timestamptz '$since') TO STDOUT;" | remote_psql > "$TMP_FILE.r"
  n_roll="$({
    echo "BEGIN; CREATE TEMP TABLE _in_u (LIKE readings_rollup INCLUDING DEFAULTS) ON COMMIT DROP; COPY _in_u FROM STDIN;"
    cat "$TMP_FILE.r"; echo '\.'
    echo "WITH ins AS (INSERT INTO readings_rollup SELECT * FROM _in_u ON CONFLICT (sensor_id, bucket_start) DO UPDATE SET count = EXCLUDED.count, sum = EXCLUDED.sum, min = EXCLUDED.min, max = EXCLUDED.max, last_value = EXCLUDED.last_value, last_at = EXCLUDED.last_at RETURNING 1) SELECT count(*) FROM ins; COMMIT;"
  } | local_psql | tail -1)"
  rm -f "$TMP_FILE.r"
  echo "$(now_jst) JST 取り込み: 測定値 +$n_read 行、1 分まとめ $n_roll 行（${since} 以降）"
}

show_status() {
  echo "-- ラズパイ"
  echo "SELECT 'readings', count(*), min(recorded_at), max(recorded_at) FROM readings; SELECT 'sensors', count(*) FROM sensors;" | remote_psql
  echo "-- ローカル"
  echo "SELECT 'readings', count(*), min(recorded_at), max(recorded_at) FROM readings; SELECT 'sensors', count(*) FROM sensors;" | local_psql
}

check_ready
if [ "$STATUS_ONLY" = 1 ]; then show_status; exit 0; fi

echo "$(now_jst) JST 設定の取り込み（$([ "$RESET_CONFIG" = 1 ] && echo 丸ごと置き換え || echo 足りない分だけ足す)）"
sync_config || exit 1
sync_readings
if [ -n "$FOLLOW" ]; then
  echo "追いかけます（${FOLLOW} 秒ごと。Ctrl+C で終了）"
  cycle=0
  while true; do
    sleep "$FOLLOW"
    cycle=$((cycle + 1))
    # 設定は 12 回に 1 回（新しいセンサーが増えたときの外部キーのため）
    if [ $((cycle % 12)) = 0 ]; then sync_config || echo "設定の取り込みに失敗しました（次の回に再試行）" >&2; fi
    sync_readings || echo "取り込みに失敗しました（次の回に再試行）" >&2
  done
fi
