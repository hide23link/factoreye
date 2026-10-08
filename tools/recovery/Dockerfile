# FactorEye 復旧ツール。作業用の Postgres を同じコンテナに入れ、Docker さえあれば
# どこでも（本番の LXC・ラズパイ・Mac）同じように動くようにする。
# Postgres は本番（postgres:15）と同じ 15 系。新しい版のダンプは古い版に流し込めないため、
# 本番の Postgres を上げたら、ここも合わせて上げる。
FROM python:3.12-slim-bookworm

# Debian のパッケージは、入れた時点で既定のクラスタを作ってしまうため止める（作業用の DB は entrypoint が作る）
RUN mkdir -p /etc/postgresql-common/createcluster.d && \
    echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.d/no-main.conf && \
    apt-get update && \
    apt-get install -y --no-install-recommends postgresql-15 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY recovery ./recovery
COPY entrypoint.sh .

# Postgres は root では起動できないため、専用の利用者で動かす
RUN useradd --system --uid 10001 --home /var/lib/recovery recovery && \
    mkdir -p /var/lib/recovery && chown recovery /var/lib/recovery
USER recovery

ENV PATH="/opt/venv/bin:/usr/lib/postgresql/15/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8090
ENTRYPOINT ["./entrypoint.sh"]
