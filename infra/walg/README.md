# PostgreSQL のバックアップ（WAL-G → R2）

クラウド版の DB のバックアップは、**WAL の追記（60 秒ごと）と、ベースバックアップ（毎日の差分、週 1 回の全体）**を、R2 の**専用バケット `factoreye-db`** に送る方式。毎晩の `pg_dump` は、やめた。
設計・試験の結果・容量と料金の見積もりは、ecopower の `docs/aws-dr-wal-design.md`。実装の計画は `docs/aws-dr-wal-plan.md`。

## R2 の中身（階層は最大 3 段）

```
factoreye-db/
├─ README.txt                 説明（バケットの直下。WAL-G は触らない）
├─ wal_005/                   WAL（DB の変更の履歴）。60 秒ごとに増える
│    └─ 000000010000000000000042.zst
└─ basebackups_005/           ベースバックアップ（DB 全体の写し）
     ├─ base_<名前>/tar_partitions/<ファイル>      中身
     └─ base_<名前>_backup_stop_sentinel.json      完了の印
```
フォルダ名は WAL-G が決めている（005 は保存形式の版）。変えられない。

**このバケットは、WAL-G 専用。** WAL-G の `delete` は、置き場の下にある WAL に見えるファイルを、すべて対象にする。ほかのバックアップと同じバケットに置くと、消してしまう（試験で、本番の別のバックアップの WAL を消す事故が実際に起きた）。**共有のバケットでは、WAL-G の `delete` を実行しない。**

| ファイル | 役割 |
|---|---|
| `walg.env.example` | 設定の雛形（R2 の鍵・置き場・圧縮・差分の世代数）。本番では `/opt/factoreye/walg/walg.env` |
| `make-conf.sh` | R2 の鍵のファイル（`/opt/factoreye/walg/r2.env`）から、`walg.env` を作る |
| `init.sh` | 有効にする（初回だけ。何度実行しても安全）。接続確認 → archive 設定 → 再起動 → WAL が届くか確認 |
| `backup.sh full｜delta` | ベースバックアップ。`full` のあと、古いバックアップと不要な WAL を削除（全体を 1 世代だけ残す） |
| `check.sh` | `backup-list`（ベースがある）と `wal-verify`（WAL に欠けがない）。毎日 |
| `monitor.sh` | **WAL を R2 に送れなくなっていないか、ディスクが埋まりそうでないか**を見る。10 分ごと。異常なら Discord に通知 |
| `bucket-README.txt` | バケットの直下に置く説明（`README.txt`） |
| `test.sh` | 上のスクリプトと復元を、ローカルの Docker で通して確かめる試験（R2 には送らない） |

## 本番で入れる手順（pgBackRest から、WAL-G への切り替え）

**この手順で、本番の DB を、新しく作り直す**（PostgreSQL のイメージが、Alpine から Debian に変わる。OS の文字の並び順が変わるため、既存のデータのインデックスと合わなくなる。現在、データはなく、失うものはない）。

前提: Mac に、`~/.factoreye-db-r2.env`（バケット `factoreye-db` だけの Object Read & Write の鍵）がある。

### 0. 事前（アプリは動かしたまま）

1. **今の pgBackRest を止める**（WAL-G のイメージには pgBackRest が入っていないため、止めないと、デプロイのあと、WAL の送信が失敗し続ける）
   ```bash
   cd /opt/factoreye
   docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres psql -U factoreye -d factoreye -c "ALTER SYSTEM RESET archive_mode" -c "ALTER SYSTEM RESET archive_command" -c "ALTER SYSTEM RESET archive_timeout"
   docker compose -f docker-compose.cloud.yml restart postgres
   rm -f /etc/cron.d/factoreye-pgbackrest
   ```
2. DR コンソール（`https://factoreye.hide23.link/admin/dr`）の「自動切り替え」が**無効**なことを確認する。停止中は、コンソールが「障害」と記録し、Discord に通知が出る。想定内。
3. 自動デプロイの前提を確認する: 本番の Docker Compose が **2.24 以上**（`docker compose version`。`env_file` の `required: false` の書き方に必要）。デプロイを実行する runner のユーザーが、`/opt/factoreye/walg/walg.env`（権限 600、所有者 root）を読めること（root でなければ、権限エラーで `compose up` が失敗する。その場合は runner が読めるグループにして 640 にする）。
4. **`main` にマージして、自動デプロイを済ませる**（PostgreSQL が、WAL-G 入りの新しいイメージで作り直される。数秒、DB が再起動する）。確認: `docker compose -f docker-compose.cloud.yml exec -T postgres wal-g --version`

### 1. 鍵を置く

Mac で（鍵は、画面に出ない）:
```bash
ssh factoreye 'umask 077; mkdir -p /opt/factoreye/walg; cat > /opt/factoreye/walg/r2.env' < ~/.factoreye-db-r2.env
```
LXC で:
```bash
cd /opt/factoreye && git pull origin main && sudo infra/walg/make-conf.sh
```

### 2. DB を新しく作り直す（アプリを止める）

```bash
cd /opt/factoreye
docker compose -f docker-compose.cloud.yml down
docker volume rm factoreye_postgres-data        # DB のデータを消す（現在、データはない）
docker compose -f docker-compose.cloud.yml up -d postgres   # 空の DB が作られる。walg.env がコンテナに渡る
docker compose -f docker-compose.cloud.yml up -d            # アプリ（起動時にテーブルを作る）
curl -s localhost/health                                     # {"status":"ok",...}
```

### 3. 有効にして、最初の全体のバックアップを取る

先に、**バケット `factoreye-db` が空（`README.txt` だけ）なことを確認する**（過去の試験や別の DB の WAL・ベースが残っていると、作り直した DB の履歴と混ざる。専用バケットなので、残っていれば Cloudflare のコンソールで全削除する。`README.txt` は、`wrangler r2 object put factoreye-db/README.txt --file infra/walg/bucket-README.txt --remote` で置ける）。

```bash
infra/walg/init.sh          # 最後に「WAL が R2 に届く」確認が成功すること（途中で PostgreSQL が数秒、再起動する）
infra/walg/backup.sh full
infra/walg/check.sh         # OK と出ること
```
- `init.sh` の確認が失敗したら、`archive_mode` は有効のままなので、WAL が溜まる。放置しない。出る案内（`walg.env` を直して再実行、または、下の「戻し方」）に従う。

### 4. cron を設定する

```bash
cat > /etc/cron.d/factoreye-walg <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# WAL-G（WAL は PostgreSQL が自動で送る）。全体は日曜、差分は月〜土、確認は毎日、監視は 10 分ごと
30 3 * * 0   root cd /opt/factoreye && infra/walg/backup.sh full  >> /var/log/factoreye-walg.log 2>&1
30 3 * * 1-6 root cd /opt/factoreye && infra/walg/backup.sh delta >> /var/log/factoreye-walg.log 2>&1
30 4 * * *   root cd /opt/factoreye && infra/walg/check.sh        >> /var/log/factoreye-walg.log 2>&1
*/10 * * * * root cd /opt/factoreye && infra/walg/monitor.sh      >> /var/log/factoreye-walg.log 2>&1
EOF
chmod 644 /etc/cron.d/factoreye-walg
```
設定ファイルの暗号化バックアップ（毎晩）は、`BACKUP_DB=off` にして、DB のダンプをやめる（従来の cron の行に `BACKUP_DB=off` を足す）:
```bash
crontab -l | grep -q 'BACKUP_DB=off' || crontab -l | sed 's#OFFSITE_S3_URI=#BACKUP_DB=off OFFSITE_S3_URI=#' | crontab -   # 2 回実行しても重複しない
```

### 5. 確認

- `archive_mode` が `on` なこと（`docker compose -f docker-compose.cloud.yml exec -T postgres psql -U factoreye -d factoreye -Atc 'show archive_mode'`）。`off` のままだと、WAL は R2 に送られない。
- DR コンソールが「正常」に戻ること。1〜2 分後、R2 の `factoreye-db/wal_005/` に WAL が増えること。
- 任意: Discord の通知（`monitor.sh`）は、Webhook の URL を 1 行だけ書いたファイル `/opt/factoreye/walg/discord-webhook`（権限 600）を置くと、有効になる。

## 日々の確認

```bash
docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres wal-g backup-list
tail -50 /var/log/factoreye-walg.log
```
失敗すると、スクリプトの終了コードが 0 以外になる。ログに `エラー` が出ていないか見る。`monitor.sh` の異常は、Discord にも通知される。

## 異常のとき（`monitor.sh` の通知、または、ログに異常が出たとき）

**WAL を R2 に送れないと、PostgreSQL は WAL を消せず、`pg_wal` が溜まり続ける。ディスクが埋まると、DB が止まり、アプリが止まる。** 最悪で、1 日に数 GB〜20 GB 溜まる（書き込みが続く場合）。

1. 状況を見る:
   ```bash
   docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres psql -U factoreye -d factoreye -c "select * from pg_stat_archiver"
   docker compose -f docker-compose.cloud.yml exec -T postgres du -sh /var/lib/postgresql/data/pg_wal
   df -h /
   infra/walg/check.sh
   ```
2. 原因を直す。よくある原因: R2 の鍵の失効・変更、R2 の障害、LXC の回線の断。鍵を変えたら、`r2.env` を直して `make-conf.sh`（FORCE=1）を実行し、`docker compose up -d postgres` で反映する。直れば、溜まっていた WAL が、自動で順に送られる。
3. **基準:** 1 時間以内に直せない、かつ、`pg_wal` が 5 GB を超える（またはディスクが 90% を超える）なら、**下の「戻し方」で、アーカイブを止める**（DB を止めないことを優先する）。直ってから、`init.sh` で再び有効にし、`backup.sh full` を取り直す。

## 戻し方（有効にしたあとで、元に戻したいとき）

```bash
docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres psql -U factoreye -d factoreye -c "ALTER SYSTEM RESET archive_mode" -c "ALTER SYSTEM RESET archive_command" -c "ALTER SYSTEM RESET archive_timeout"
docker compose -f docker-compose.cloud.yml restart postgres
```
cron の行（`/etc/cron.d/factoreye-walg`）も消す。データのボリューム（DB 本体）は、そのまま使える。

## バージョン

- **WAL-G のバージョンは、本番と、DR の控えで、そろえる**（復元の互換性）。どちらも、`infra/cloud/postgres/Dockerfile` から作ったイメージを使う（バージョンとハッシュを固定している。更新するときは、両方を変える）。
- 本番のイメージを作り直したら（デプロイで再ビルド）、**ecopower の `tools/aws-dr/publish-images.sh` を実行して、控えのイメージも更新する**（`docs/factoreye-architecture.md` の本番運用ルール）。

## 注意

- `walg.env` には R2 の鍵が入る。Git に入れない。権限は 600。
- WAL-G の `delete`（`backup.sh full` の中で実行）は、**専用バケット `factoreye-db` の中だけ**に及ぶ。鍵も、このバケットだけに権限がある（ほかのバケットには、触れない）。
- `check.sh` の `wal-verify` は、WAL の欠けを調べる。DB が大きくなったら、週 1 回にする。
- 復元（控えの EC2 での起動）は、ecopower の `tools/aws-dr/standby-boot.sh`。
