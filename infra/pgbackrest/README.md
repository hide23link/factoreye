# PostgreSQL のバックアップ（pgBackRest → R2）

クラウド版の DB のバックアップは、**WAL の追記（60 秒ごと）と、ベースバックアップ（毎日の差分）**を、R2 に送る方式。毎晩の `pg_dump` は、やめた。
設計・試験の結果・容量と料金の見積もりは、ecopower の `docs/aws-dr-wal-design.md`。実装の計画は `docs/aws-dr-wal-plan.md`。

| ファイル | 役割 |
|---|---|
| `pgbackrest.conf.example` | 設定の雛形（R2 の鍵を入れて、本番の `/opt/factoreye/pgbackrest/pgbackrest.conf` に置く） |
| `make-conf.sh` | 既存の R2 の鍵（`.offsite-s3.env`）から、`pgbackrest.conf` を作る |
| `init.sh` | 有効にする（初回だけ。何度実行しても安全）。ステンザ作成 → archive 設定 → 再起動 → check |
| `backup.sh full｜diff` | ベースバックアップ（全体は週 1 回、差分は毎日） |
| `check.sh` | `check`（WAL が R2 に届くか）と `verify`（欠け・破損がないか）。毎日 |
| `monitor.sh` | **WAL を R2 に送れなくなっていないか、ディスクが埋まりそうでないか**を見る。10 分ごと。異常なら Discord に通知 |
| `test.sh` | 上のスクリプトと復元を、ローカルの Docker で通して確かめる試験（R2 には送らない） |

## 本番を停止して入れる手順（初回）

前提: 本番の `/opt/factoreye/.offsite-s3.env`（R2 の鍵。バケット `factoreye-backup` の Object Read & Write）がある。

### 0. 事前（アプリは動かしたまま）

1. **設定ファイルを作る**（既存の `/opt/factoreye/.offsite-s3.env`＝本番のバックアップを R2 に送る鍵から、自動で作る。鍵を貼り付けなくてよく、画面にも出ない。権限 600、所有者 uid 70）。**デプロイの前に作る**（コンテナが、この場所をマウントするため）
   ```bash
   cd /opt/factoreye && git pull origin main
   sudo infra/pgbackrest/make-conf.sh
   ```
   作られた設定の内容（鍵は除く）を確認する: `sudo grep -v 'key' /opt/factoreye/pgbackrest/pgbackrest.conf | grep -v '^#' | grep .`
   （バケットは `factoreye-backup`、`repo1-path` は `/pgbackrest/prod`。R2 の鍵の権限は、バケットの Object Read & Write が必要。）
2. **Discord の通知（任意）**: `monitor.sh` の通知先。Webhook の URL を 1 行だけ書いたファイルを置く（無ければ、通知なしで、ログだけ）
   ```bash
   sudo install -m 600 /dev/null /opt/factoreye/pgbackrest/discord-webhook && sudo -e /opt/factoreye/pgbackrest/discord-webhook
   ```
3. DR コンソール（`https://factoreye.hide23.link/admin/dr`）の「自動切り替え」が**無効**なことを確認する（停止中に、控えへ切り替わらないように）。停止中は、コンソールが「障害」と記録し、Discord に通知が出る。想定内。
4. **`main` にマージして、自動デプロイを先に済ませる**（PostgreSQL が、pgBackRest 入りの新しいイメージで作り直される。数秒、DB が再起動する。アーカイブは、まだ無効）。デプロイが終わったことを確認:
   ```bash
   docker compose -f docker-compose.cloud.yml exec -T postgres pgbackrest version
   ```
   バージョンを控えておく（DR の控えと、そろえるため。下の「バージョン」）。

### 1. アプリを止める（DB は動かしたまま）

```bash
cd /opt/factoreye
docker compose -f docker-compose.cloud.yml stop backend frontend caddy
```

### 2. 有効にする

```bash
infra/pgbackrest/init.sh
```
最後に `check` が成功すること。途中で PostgreSQL が数秒、再起動する（`archive_mode` の変更に必要）。

- **`check` が失敗したら**: `archive_mode` は有効のままなので、WAL が R2 に送れず、`pg_wal` が溜まり続ける。放置しない。
  ① `/opt/factoreye/pgbackrest/pgbackrest.conf` を直して（エンドポイントは `https://` なし、鍵、バケット名）、`init.sh` を**もう一度**実行する（安全）。
  ② 直せないなら、下の「戻し方」で、`archive_mode` を元に戻す。

### 3. 最初の全体のバックアップ

```bash
infra/pgbackrest/backup.sh full
```
DB が小さい間は、数秒〜数十秒。`info` の出力に `full backup` が 1 つ出ること。

### 4. cron を設定する

`crontab -e`。時刻は、LXC の時刻（JST）。
```cron
# 全体（日曜）・差分（月〜土）・確認（毎日）。ログは /var/log/factoreye-pgbackrest.log
30 3 * * 0   cd /opt/factoreye && infra/pgbackrest/backup.sh full >> /var/log/factoreye-pgbackrest.log 2>&1
30 3 * * 1-6 cd /opt/factoreye && infra/pgbackrest/backup.sh diff >> /var/log/factoreye-pgbackrest.log 2>&1
30 4 * * *   cd /opt/factoreye && infra/pgbackrest/check.sh       >> /var/log/factoreye-pgbackrest.log 2>&1
# WAL を送れなくなっていないか（10 分ごと。異常なら Discord に通知）
*/10 * * * * cd /opt/factoreye && infra/pgbackrest/monitor.sh     >> /var/log/factoreye-pgbackrest.log 2>&1
# 設定ファイルの暗号化バックアップだけ（DB のダンプはやめた）。従来の 03:00 の行を、これに置き換える
0 3 * * *    cd /opt/factoreye && BACKUP_DB=off OFFSITE_S3_URI=s3://factoreye-backup COMPOSE_FILE=docker-compose.cloud.yml BACKUP_PASSPHRASE_FILE=/root/.factoreye-backup-passphrase ./infra/backup.sh >> /var/log/factoreye-backup.log 2>&1
```

### 5. アプリを起動して、確認

```bash
docker compose -f docker-compose.cloud.yml up -d
curl -s localhost/health            # {"status":"ok",...}
infra/pgbackrest/monitor.sh         # OK と出ること
```
DR コンソールが「正常」に戻ること。1〜2 分後、R2 の `pgbackrest/prod/archive/` に、WAL が増え続けること（60 秒ごと）。

### 6. 古いダンプを消す（任意）

現在データがないので、消してよい。R2 の直下の `factoreye-*.sql.gz`（と `.sha256`）。バケットのロック（30 日）で消せない場合は、期限を待つ。**設定ファイルのバックアップ（`-config.tar.gz.enc`）は、消さない**（DR の控えの起動に必要）。

## 日々の確認

```bash
docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres pgbackrest --stanza=factoreye info
tail -50 /var/log/factoreye-pgbackrest.log
```

失敗すると、スクリプトの終了コードが 0 以外になる。ログに `エラー` や `ERROR` が出ていないか見る。`monitor.sh` の異常は、Discord にも通知される。

## 異常のとき（`monitor.sh` の通知、または、ログに異常が出たとき）

**WAL を R2 に送れないと、PostgreSQL は WAL を消せず、`pg_wal` が溜まり続ける。ディスクが埋まると、DB が止まり、アプリが止まる。** 最悪で、1 日に数 GB〜20 GB 溜まる（書き込みが続く場合）。

1. 状況を見る:
   ```bash
   docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres psql -U factoreye -d factoreye -c "select * from pg_stat_archiver"
   docker compose -f docker-compose.cloud.yml exec -T postgres du -sh /var/lib/postgresql/data/pg_wal
   df -h /
   infra/pgbackrest/check.sh
   ```
2. 原因を直す。よくある原因: R2 の鍵の失効・変更、R2 の障害、LXC の回線の断。鍵を変えたら、`pgbackrest.conf` を直す。直れば、溜まっていた WAL が、自動で順に送られる。
3. **基準:** 1 時間以内に直せない、かつ、`pg_wal` が 5 GB を超える（またはディスクが 90% を超える）なら、**下の「戻し方」で、アーカイブを止める**（DB を止めないことを優先する）。直ってから、`init.sh` で再び有効にし、`backup.sh full` を取り直す。

## 戻し方（有効にしたあとで、元に戻したいとき）

```bash
docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres psql -U factoreye -d factoreye -c "ALTER SYSTEM RESET archive_mode" -c "ALTER SYSTEM RESET archive_command" -c "ALTER SYSTEM RESET archive_timeout"
docker compose -f docker-compose.cloud.yml restart postgres
```
cron の行も消す。データのボリューム（DB 本体）は、そのまま使える。

## バージョン

- **pgBackRest のバージョンは、本番と、DR の控えで、そろえる**（復元の互換性）。どちらも、`infra/cloud/postgres/Dockerfile` から作ったイメージを使う（Dockerfile は、バージョンを固定していない）。
- 本番のイメージを作り直したら（デプロイで再ビルド）、**ecopower の `tools/aws-dr/publish-images.sh` を実行して、控えのイメージも更新する**（`docs/factoreye-architecture.md` の本番運用ルール）。`pgbackrest version` を、更新の記録に残す。

## 注意

- **順番が大事**: ステンザを作ってから、`archive_mode` を有効にする（`init.sh` がその順で行う）。逆にすると、WAL の送信が失敗し続ける。
- 本番の DB の管理者のロールは `factoreye`。設定の `pg1-user`・`pg1-database` で指定している（既定の `postgres` ロールは、存在しない）。
- 設定ファイルには R2 の鍵が入る。Git に入れない。権限は 600、所有者は uid 70。
- `check.sh` の `verify` は、毎日 R2 の全ファイルを読む。DB が大きくなったら、週 1 回にする（外向きの通信は無料）。
- pgBackRest のログは、コンテナの中（`/var/log/pgbackrest`）にあり、コンテナを作り直すと消える。cron のログ（`/var/log/factoreye-pgbackrest.log`）は残る。
- 復元（控えの EC2 での起動）は、ecopower の `tools/aws-dr/standby-boot.sh`。
