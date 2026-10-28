# FactorEye 復旧ツール。作業用の Postgres を同じコンテナに入れ、Docker さえあれば
# どこでも（本番の LXC・ラズパイ・Mac）同じように動くようにする。

# ビルド段: 依存だけを venv に入れる（pip 自体は実行に要らないので venv から外す）
FROM python:3.12-slim-bookworm AS builder
WORKDIR /app
COPY requirements.txt .
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt && \
    /opt/venv/bin/pip uninstall -y pip

# WAL-G（R2 の本番の DB のバックアップから復旧するために使う。読み取りのコマンドだけ）。
# バージョンとハッシュを固定して取る（本番の infra/cloud/postgres/Dockerfile と同じ。更新するときは両方を変える）
FROM python:3.12-slim-bookworm AS walg
ARG TARGETARCH
ARG WALG_VERSION=v3.0.9
ARG SHA_AMD64=d6795c663894d836ba20840bffe8970aed81bbe25d3151bd4951f6f9c362def9
ARG SHA_AARCH64=072eb4a4a119f817e1fa888c64a776b01e3453b2e0d967a67d149adb18fde652
RUN set -eux; \
    case "$TARGETARCH" in amd64) A=amd64; H="$SHA_AMD64";; arm64) A=aarch64; H="$SHA_AARCH64";; *) echo "非対応の CPU: $TARGETARCH"; exit 1;; esac; \
    apt-get update; apt-get install -y --no-install-recommends curl ca-certificates; \
    curl -fsSL -o /wal-g "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-${A}"; \
    echo "${H}  /wal-g" | sha256sum -c -; chmod 755 /wal-g

# 実行段: Postgres は本番（postgres:15）と同じ 15 系。新しい版のダンプは古い版に流し込めないため、
# 本番の Postgres を上げたら、ここも合わせて上げる。
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
COPY --from=walg /wal-g /usr/local/bin/wal-g

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
