#!/bin/bash
# 取り込み側のマシン（ラズパイなど）の状態を、一定間隔で記録する（ssh 経由、読み取りだけ）。
#   使い方: TARGET=user@192.0.2.10 monitor.sh <回数> <待つ秒数（既定 25）> [出力（既定 ./logs/monitor.log）]
#   環境変数: DB_CONTAINER（既定 factoreye-postgres-1）
# 列: 時刻(UTC) load1 温度C メモリ使用MB backend-cpu% postgres-cpu% lan-ingest-cpu% ディスク使用% readings件数
set -euo pipefail
COUNT=${1:?回数}; WAIT=${2:-25}; OUT=${3:-./logs/monitor.log}
: "${TARGET:?TARGET（ssh の宛先）を指定してください}"
DB=${DB_CONTAINER:-factoreye-postgres-1}
mkdir -p "$(dirname "$OUT")"
echo "時刻(UTC) load1 温度C メモリ使用MB backend-cpu% postgres-cpu% lan-ingest-cpu% ディスク使用% readings件数" > "$OUT"
for _ in $(seq 1 "$COUNT"); do
  ssh -o ConnectTimeout=10 -o BatchMode=yes "$TARGET" "
    t=\$(date -u +%H:%M:%S); l=\$(cut -d' ' -f1 /proc/loadavg)
    c=\$(( \$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0) / 1000 ))
    m=\$(free -m | awk '/Mem:/{print \$3}'); d=\$(df / | awk 'NR==2{print \$5}')
    s=\$(docker stats --no-stream --format '{{.Name}}={{.CPUPerc}}' | tr '\n' ' ')
    b=\$(echo \"\$s\" | grep -o 'backend-1=[0-9.]*' | cut -d= -f2); p=\$(echo \"\$s\" | grep -o 'postgres-1=[0-9.]*' | cut -d= -f2)
    n=\$(echo \"\$s\" | grep -o 'lan-ingest-1=[0-9.]*' | cut -d= -f2)
    r=\$(docker exec $DB sh -c 'psql -U \$POSTGRES_USER \$POSTGRES_DB -At -c \"select count(*) from readings\"')
    echo \"\$t \$l \$c \$m \$b \$p \$n \$d \$r\"" >> "$OUT" 2>&1 || true
  sleep "$WAIT"
done
echo "MONITOR-DONE" >> "$OUT"
