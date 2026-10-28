# PostgreSQL のバックアップ（pgBackRest → R2）

クラウド版の DB のバックアップは、**WAL の追記（60 秒ごと）と、ベースバックアップ（毎日の差分）**を、R2 に送る方式。毎晩の `pg_dump` は、やめた。
設計・試験の結果・容量と料金の見積もりは、ecopower の `docs/aws-dr-wal-design.md`。実装の計画は `docs/aws-dr-wal-plan.md`。

| ファイル | 役割 |
|---|---|
| `pgbackrest.conf.example` | 設定の雛形（R2 の鍵を入れて、本番の `/opt/factoreye/pgbackrest/pgbackrest.conf` に置く） |
| `init.sh` | 有効にする（初回だけ。何度実行しても安全）。ステンザ作成 → archive 設定 → 再起動 → check |
| `backup.sh full｜diff` | ベースバックアップ（全体は週 1 回、差分は毎日） |
| `check.sh` | `check`（WAL が R2 に届くか）と `verify`（欠け・破損がないか）。毎日 |
| `test.sh` | 上の 3 つと復元を、ローカルの Docker で通して確かめる試験（R2 には送らない） |

## 本番を停止して入れる手順（初回）

前提: `main` に、このディレクトリのスクリプトと、`docker-compose.cloud.yml`（pgBackRest 入りの postgres）が入っている。R2 の Access Key ID と Secret（バケット `factoreye-backup` の Object Read & Write）を用意する。

1. **事前**
   - DR コンソール（`https://factoreye.hide23.link/admin/dr`）の「自動切り替え」が**無効**なことを確認する（停止中に、控えへ切り替わらないように）。停止中は、コンソールが「障害」と記録し、Discord に通知が出る。想定内。
2. **アプリを止める**（DB は動かしたまま）
   ```bash
   cd /opt/factoreye
   docker compose -f docker-compose.cloud.yml stop backend frontend caddy
   ```
3. **新しいイメージで、PostgreSQL を作り直す**（`main` のマージで、自動デプロイが走っていれば済んでいる。そうでなければ）
   ```bash
   git pull origin main
   docker compose -f docker-compose.cloud.yml up -d --build postgres
   ```
4. **設定ファイルを置く**（Git 管理外。所有者は postgres＝uid 70、権限 600）
   ```bash
   sudo mkdir -p /opt/factoreye/pgbackrest
   sudo install -o 70 -g 70 -m 600 infra/pgbackrest/pgbackrest.conf.example /opt/factoreye/pgbackrest/pgbackrest.conf
   sudo -e /opt/factoreye/pgbackrest/pgbackrest.conf     # <アカウント ID>、<R2 の Access Key ID>、<R2 の Secret Access Key> を埋める
   sudo chown 70:70 /opt/factoreye/pgbackrest/pgbackrest.conf && sudo chmod 600 /opt/factoreye/pgbackrest/pgbackrest.conf
   ```
5. **有効にする**
   ```bash
   infra/pgbackrest/init.sh
   ```
   最後に `check` が成功すること。途中で PostgreSQL が数秒、再起動する（`archive_mode` の変更に必要）。
6. **最初の全体のバックアップ**
   ```bash
   infra/pgbackrest/backup.sh full
   ```
   DB が小さい間は、数秒〜数十秒。`info` の出力に `full backup` が 1 つ出ること。
7. **cron を設定する**（`crontab -e`。時刻は、LXC の時刻＝JST）
   ```cron
   # 全体（日曜）・差分（月〜土）・確認（毎日）。ログは /var/log/factoreye-pgbackrest.log
   30 3 * * 0   cd /opt/factoreye && infra/pgbackrest/backup.sh full >> /var/log/factoreye-pgbackrest.log 2>&1
   30 3 * * 1-6 cd /opt/factoreye && infra/pgbackrest/backup.sh diff >> /var/log/factoreye-pgbackrest.log 2>&1
   30 4 * * *   cd /opt/factoreye && infra/pgbackrest/check.sh       >> /var/log/factoreye-pgbackrest.log 2>&1
   # 設定ファイルの暗号化バックアップだけ（DB のダンプはやめた）。従来の 03:00 の行を、これに置き換える
   0 3 * * *    cd /opt/factoreye && BACKUP_DB=off OFFSITE_S3_URI=s3://factoreye-backup COMPOSE_FILE=docker-compose.cloud.yml BACKUP_PASSPHRASE_FILE=/root/.factoreye-backup-passphrase ./infra/backup.sh >> /var/log/factoreye-backup.log 2>&1
   ```
8. **アプリを起動して、確認**
   ```bash
   docker compose -f docker-compose.cloud.yml up -d
   curl -s localhost/health            # {"status":"ok",...}
   ```
   DR コンソールが「正常」に戻ること。1〜2 分後、R2 の `pgbackrest/prod/archive/` に、WAL が増え続けること（60 秒ごと）。
9. **古いダンプを消す**（任意。現在データがないので消してよい）
   - R2 の直下の `factoreye-*.sql.gz`（と `.sha256`）。バケットのロック（30 日）で、消せない場合は、期限を待つ。**設定ファイルのバックアップ（`-config.tar.gz.enc`）は、消さない。**

## 日々の確認

```bash
docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres pgbackrest --stanza=factoreye info
tail -50 /var/log/factoreye-pgbackrest.log
```

- 失敗すると、スクリプトの終了コードが 0 以外になる。ログに `エラー` や `ERROR` が出ていないか見る。
- **WAL が R2 に送られなくなると、`pg_wal` が溜まり続け、ディスクが埋まる。** `df -h /` と、`docker compose ... exec postgres du -sh /var/lib/postgresql/data/pg_wal` を、ときどき見る。

## 戻し方（有効にしたあとで、元に戻したいとき）

```bash
docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres psql -U factoreye -d factoreye -c "ALTER SYSTEM RESET archive_mode" -c "ALTER SYSTEM RESET archive_command" -c "ALTER SYSTEM RESET archive_timeout"
docker compose -f docker-compose.cloud.yml restart postgres
```
cron の行も消す。データのボリューム（DB 本体）は、そのまま使える。

## 注意

- **順番が大事**: ステンザを作ってから、`archive_mode` を有効にする（`init.sh` がその順で行う）。逆にすると、WAL の送信が失敗し続ける。
- 本番の DB の管理者のロールは `factoreye`。設定の `pg1-user`・`pg1-database` で指定している（既定の `postgres` ロールは、存在しない）。
- 設定ファイルには R2 の鍵が入る。Git に入れない。権限は 600、所有者は uid 70。
- 復元（控えの EC2 での起動）は、ecopower の `tools/aws-dr/standby-boot.sh`。
