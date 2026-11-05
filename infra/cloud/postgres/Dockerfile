# 本番（クラウド版）の PostgreSQL。公式の postgres:15（Debian）に、DR のバックアップ用の WAL-G を足したもの。
# WAL を追記で R2 に送り、ベースバックアップ（毎日の差分）を取る。設計は ecopower の docs/aws-dr-wal-design.md。
# このイメージを入れただけでは、何も送らない（archive_mode は off のまま）。有効にする手順は infra/walg/README.md。
#
# Debian にしている理由: WAL-G の配布物は glibc 向けで、Alpine（musl）では動かない。
#   OS（libc）が変わると、文字の並び順（照合順序）が変わり、既存のデータのインデックスと合わなくなる。
#   Alpine で作った DB のデータを、このイメージでそのまま使わない（新しく作る）。
FROM postgres:15
ARG TARGETARCH
# WAL-G はバージョンとハッシュを固定して取る（配布物の改ざんを防ぐ。更新するときは、両方を変える）
ARG WALG_VERSION=v3.0.9
ARG SHA_AMD64=d6795c663894d836ba20840bffe8970aed81bbe25d3151bd4951f6f9c362def9
ARG SHA_AARCH64=072eb4a4a119f817e1fa888c64a776b01e3453b2e0d967a67d149adb18fde652
RUN set -eux; \
    case "$TARGETARCH" in amd64) A=amd64; H="$SHA_AMD64";; arm64) A=aarch64; H="$SHA_AARCH64";; *) echo "非対応の CPU: $TARGETARCH"; exit 1;; esac; \
    apt-get update; apt-get install -y --no-install-recommends curl ca-certificates; \
    curl -fsSL -o /usr/local/bin/wal-g "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-${A}"; \
    echo "${H}  /usr/local/bin/wal-g" | sha256sum -c -; chmod 755 /usr/local/bin/wal-g; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    wal-g --version
