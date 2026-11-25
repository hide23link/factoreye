# PostgreSQL のバックアップ（WAL-G）

クラウド版の DB のバックアップです。**WAL の追記（60 秒ごと）と、ベースバックアップ（毎日の差分、週 1 回の全体）**を、S3 互換の置き場（Cloudflare R2 など）の**専用のバケット**に送ります。毎晩の `pg_dump` の代わりで、失うデータは最大で約 1 分です。
OSS 版（`docker-compose.yml`）も同じ PostgreSQL のイメージ（`infra/cloud/postgres/`、WAL-G 入り）を使いますが、`init.sh` を実行するまでは何もしません。

| ファイル | 役割 |
|---|---|
| `walg.env.example` | 設定の雛形（鍵・置き場・圧縮・差分の世代数）。本番では `/opt/factoreye/walg/walg.env`（Git 管理外、権限 600） |
| `make-conf.sh` | 鍵のファイル（`/opt/factoreye/walg/r2.env`）から `walg.env` を作る |
| `init.sh` | 有効にする（初回だけ。何度実行しても安全）。設定の確認 → 置き場に届くか → archive の設定 → 再起動 → WAL が届くか |
| `backup.sh full｜delta` | ベースバックアップ。`full` のあと、古いバックアップと不要な WAL を消す（全体を 1 世代だけ残す） |
| `check.sh` | `backup-list`（ベースがある）と `wal-verify`（WAL に欠けがない）。毎日 |
| `monitor.sh` | WAL を送れなくなっていないか・ディスクが埋まりそうでないかを見る。10 分ごと。異常なら Discord に通知（`/opt/factoreye/walg/discord-webhook` に URL を 1 行置いたときだけ） |
| `bucket-README.txt` | バケットの直下に置く説明 |
| `test.sh` | 上のスクリプトと復元を、ローカルの Docker で通す試験（外へは送らない） |

**バケットは WAL-G 専用にします。** WAL-G の `delete`（`backup.sh full` の中で実行）は、置き場の下にある WAL に見えるファイルをすべて対象にするので、ほかのバックアップと同じバケットに置くと消してしまいます。鍵も、そのバケットだけに権限を付けます。

## 入れる手順

1. 鍵のファイル（`AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY`・`AWS_ENDPOINT_URL` の 3 行）を `/opt/factoreye/walg/r2.env`（権限 600）に置き、`sudo infra/walg/make-conf.sh` で `walg.env` を作る。`WALG_S3_PREFIX` を自分のバケットにする。自動デプロイのユーザーが読めるよう、`walg.env` はそのユーザーのグループで 640 にする
2. `docker compose -f docker-compose.cloud.yml up -d postgres`（`walg.env` がコンテナに渡る）
3. バケットが空なことを確かめてから、`infra/walg/init.sh` → `infra/walg/backup.sh full` → `infra/walg/check.sh`（OK と出ること）
4. cron を設定する:

   ```
   30 3 * * 0   root cd /opt/factoreye && infra/walg/backup.sh full  >> /var/log/factoreye-walg.log 2>&1
   30 3 * * 1-6 root cd /opt/factoreye && infra/walg/backup.sh delta >> /var/log/factoreye-walg.log 2>&1
   30 4 * * *   root cd /opt/factoreye && infra/walg/check.sh        >> /var/log/factoreye-walg.log 2>&1
   */10 * * * * root cd /opt/factoreye && infra/walg/monitor.sh      >> /var/log/factoreye-walg.log 2>&1
   ```

   設定ファイルの暗号化バックアップ（`infra/backup.sh`）は、`BACKUP_DB=off` を付けて続ける（[`infra/README.md`](../README.md)）

5. 確認: `show archive_mode` が `on`、数分後に置き場の `wal_005/` に WAL が増えること

日々の確認は `docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres wal-g backup-list` と `tail -50 /var/log/factoreye-walg.log` です。

## 異常のとき

WAL を置き場に送れないと、PostgreSQL は WAL を消せず `pg_wal` が溜まり続けます。ディスクが埋まると DB が止まります。

1. 状況を見る: `select * from pg_stat_archiver`、`du -sh /var/lib/postgresql/data/pg_wal`（コンテナの中）、`df -h /`、`infra/walg/check.sh`
2. 原因を直す（よくあるのは鍵の失効・変更、置き場の障害、回線の断）。鍵を変えたら `r2.env` を直し、`FORCE=1 infra/walg/make-conf.sh` → `docker compose -f docker-compose.cloud.yml up -d postgres`。直れば、溜まった WAL は自動で順に送られる
3. 1 時間以内に直せず、`pg_wal` が 5 GB を超える（またはディスクが 90% を超える）なら、下の「戻し方」でアーカイブを止める（DB を止めないことを優先）。直ってから `init.sh` で有効にし直し、`backup.sh full` を取り直す

## 戻し方

```bash
docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres psql -U factoreye -d factoreye \
  -c "ALTER SYSTEM RESET archive_mode" -c "ALTER SYSTEM RESET archive_command" -c "ALTER SYSTEM RESET archive_timeout"
docker compose -f docker-compose.cloud.yml restart postgres
```

cron の行も消します。DB 本体（データのボリューム）は、そのまま使えます。

## 注意

- WAL-G の版は、本番と復元に使う側（復旧ツール・災害時の控え）でそろえる。どちらも `infra/cloud/postgres/Dockerfile` の版とハッシュを使う
- `walg.env` には鍵が入る。Git に入れない
- 置き場からの復元（本番に無い行だけを足す）は、復旧ツールの「R2 から復旧する」（[`tools/recovery/README.md`](../../tools/recovery/README.md)）
