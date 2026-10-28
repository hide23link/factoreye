# 本番（クラウド版）の PostgreSQL。公式の postgres:15-alpine に、DR のバックアップ用の pgBackRest を足しただけ。
# WAL を追記で R2 に送り、ベースバックアップ（毎日の差分）を取る。設計は ecopower の docs/aws-dr-wal-design.md。
# このイメージを入れただけでは、何も送らない（archive_mode は off のまま）。有効にする手順は infra/pgbackrest/README.md。
FROM postgres:15-alpine
RUN apk add --no-cache pgbackrest && pgbackrest version
