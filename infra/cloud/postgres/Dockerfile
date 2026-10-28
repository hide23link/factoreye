# 本番（クラウド版）の PostgreSQL。公式の postgres:15-alpine に、DR のバックアップ用の pgBackRest を足したもの。
# WAL を追記で R2 に送り、ベースバックアップ（毎日の差分）を取る。設計は ecopower の docs/aws-dr-wal-design.md。
# このイメージを入れただけでは、何も送らない（archive_mode は off のまま）。有効にする手順は infra/pgbackrest/README.md。
FROM postgres:15-alpine
# spool: 非同期の WAL 送信の作業場所。log: pgBackRest のログ。どちらも postgres ユーザーが書けること
RUN apk add --no-cache pgbackrest \
 && mkdir -p /var/spool/pgbackrest /var/log/pgbackrest \
 && chown postgres:postgres /var/spool/pgbackrest /var/log/pgbackrest \
 && pgbackrest version
