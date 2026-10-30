#!/bin/bash
# 試験の準備: センサーと機器を作り、機器ごとのキーを KEYS_DIR/key-NN に保存する。
#   使い方: setup_devices.sh <か所の数> [KEYS_DIR（既定 ./keys）]
#   環境変数: TARGET  ssh の宛先（例 user@192.0.2.10）。空なら、このマシンの Docker を使う
#             BACKEND バックエンドのコンテナ名（既定 factoreye-backend-1）
# キーは秘密情報。画面には出さず、権限 600 のファイルにだけ保存する。試験が終わったら必ず消す（cleanup）。
set -euo pipefail
SITES=${1:?か所の数を指定してください}
KEYS_DIR=${2:-./keys}
BACKEND=${BACKEND:-factoreye-backend-1}
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp)
chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT

if [ -n "${TARGET:-}" ]; then
  ssh -o BatchMode=yes "$TARGET" "docker exec -i -e SITES=$SITES $BACKEND python -" < "$HERE/create_devices.py" > "$TMP"
else
  docker exec -i -e SITES="$SITES" "$BACKEND" python - < "$HERE/create_devices.py" > "$TMP"
fi

mkdir -p "$KEYS_DIR" && chmod 700 "$KEYS_DIR"
python3 - "$TMP" "$KEYS_DIR" <<'PY'
import os, sys
tmp, keys_dir = sys.argv[1:3]
rows = [line.split() for line in open(tmp) if len(line.split()) == 3]
bad = [r[0] for r in rows if r[2] != "0"]
for n, key, _ in rows:
    path = os.path.join(keys_dir, f"key-{n}")
    with open(path, "w") as f:
        f.write(key + "\n")
    os.chmod(path, 0o600)
print(f"保存したキー: {len(rows)} 個（{keys_dir}）/ 所属できなかった: {bad or 'なし'}")
PY
