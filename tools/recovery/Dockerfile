# FactorEye 復旧ツール。作業用の Postgres を同じコンテナに入れ、Docker さえあれば
# どこでも（本番の LXC・ラズパイ・Mac）同じように動くようにする。
# Postgres は本番（postgres:15）と同じ 15 系。新しい版のダンプは古い版に流し込めないため、
# 本番の Postgres を上げたら、ここも合わせて上げる。
# ビルド段: 依存だけを venv に入れる（pip 自体は実行に要らないので venv から外す）
FROM python:3.12-slim-bookworm AS builder
WORKDIR /app
COPY requirements.txt .
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt && \
    /opt/venv/bin/pip uninstall -y pip

FROM python:3.12-slim-bookworm

# Debian のパッケージは、入れた時点で既定のクラスタを作ってしまうため止める（作業用の DB は entrypoint が作る）
RUN mkdir -p /etc/postgresql-common/createcluster.d && \
    echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.d/no-main.conf && \
    apt-get update && \
    apt-get install -y --no-install-recommends postgresql-15 && \
    # JIT（LLVM と z3 で約 120MB）は、作業用の DB には不要。entrypoint で jit=off にして、ライブラリごと外す。
    # 管理スクリプト用の Perl（postgresql-common が引く）も、initdb・pg_ctl を直接呼ぶので使わない
    dpkg --purge --force-depends libllvm14 libz3-4 perl perl-modules-5.36 libperl5.36 && \
    rm -rf /usr/lib/postgresql/15/lib/llvmjit.so /usr/lib/postgresql/15/lib/llvmjit_types.bc /usr/lib/postgresql/15/lib/bitcode && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR /app
COPY --from=builder /opt/venv /opt/venv

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
