# PostgreSQL のバックアップ（WAL-G → R2）

クラウド版の DB のバックアップ方式。**WAL の追記（60 秒ごと）とベースバックアップ**（日次の差分、週 1 回の全体）を、R2 の**専用バケット `factoreye-db`** に送ります。毎晩の `pg_dump` は使いません。設計と容量の見積もりは、ecopower の `docs/aws-dr-wal-design.md` にあります。

## R2 の中身

```
factoreye-db/
├─ README.txt                 説明（バケット直下。WAL-G は触らない）
├─ wal_005/                   WAL（DB の変更の履歴）
└─ basebackups_005/           ベースバックアップ（DB 全体の写し）
```

フォルダ名は WAL-G が決める（005 は保存形式の版）。

**このバケットは WAL-G 専用です。** WAL-G の `delete` は、置き場の下にあるすべての WAL が対象になります。ほかのバックアップと同じバケットに置くと、消してしまいます（試験で実際に起きた）。共有のバケットでは `delete` を実行しないでください。

| ファイル | 役割 |
|---|---|
| `walg.env.example` | 設定の雛形。本番では `/opt/factoreye/walg/walg.env`（権限 600、Git 管理外） |
| `make-conf.sh` | R2 の鍵（`/opt/factoreye/walg/r2.env`）から `walg.env` を作る |
| `init.sh` | 有効にする（何度実行しても安全）。接続確認 → archive 設定 → 再起動 → WAL が届くか確認 |
| `backup.sh full｜delta` | ベースバックアップ。`full` のあと、古いバックアップと不要な WAL を削除（全体を 1 世代だけ残す） |
| `check.sh` | `backup-list`（ベースがある）と `wal-verify`（WAL に欠けがない）。毎日 |
| `monitor.sh` | WAL が R2 に送れなくなっていないか、ディスクが埋まりそうでないかを見る。10 分ごと。異常は Discord に通知 |
| `bucket-README.txt` | バケット直下に置く `README.txt` の中身 |
| `test.sh` | 上のスクリプトと復元を、ローカルの Docker で通して確かめる（R2 には送らない） |

## 有効にする（新しい環境で）

前提: `r2.env`（バケット `factoreye-db` だけの Object Read & Write の鍵）がある。

1. `make-conf.sh` で `walg.env` を作る。自動デプロイの runner（ユーザー `factoreye`）が読めるように、`walg.env` の所有者・権限を合わせる（読めないと `compose up` が permission denied で失敗する）
2. バケットが**空**（`README.txt` だけ）なことを確かめる。過去の試験や別の DB の WAL・ベースが残っていると、履歴が混ざる
3. `init.sh` → `backup.sh full` → `check.sh`。`init.sh` の最後の「WAL が R2 に届く」確認が成功すること
4. cron を設定する:

   ```
   SHELL=/bin/bash
   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   # 全体は日曜、差分は月〜土、確認は毎日、監視は 10 分ごと
   30 3 * * 0   root cd /opt/factoreye && infra/walg/backup.sh full  >> /var/log/factoreye-walg.log 2>&1
   30 3 * * 1-6 root cd /opt/factoreye && infra/walg/backup.sh delta >> /var/log/factoreye-walg.log 2>&1
   30 4 * * *   root cd /opt/factoreye && infra/walg/check.sh        >> /var/log/factoreye-walg.log 2>&1
   */10 * * * * root cd /opt/factoreye && infra/walg/monitor.sh      >> /var/log/factoreye-walg.log 2>&1
   ```

5. 設定ファイルの暗号化バックアップ（毎晩）は、`BACKUP_DB=off` にして DB のダンプをやめる（[`infra/README.md`](../README.md) の「設定ファイルの控え」を参照）

任意: Discord の通知は、Webhook の URL を 1 行だけ書いたファイル `/opt/factoreye/walg/discord-webhook`（権限 600）を置くと有効になる。

確認: `archive_mode` が `on` であること。R2 の `factoreye-db/wal_005/` に WAL が増えること。

## 日々の確認

```bash
docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres wal-g backup-list
tail -50 /var/log/factoreye-walg.log
```

失敗するとスクリプトの終了コードが 0 以外になる。ログに `エラー` が出ていないか見る。`monitor.sh` の異常は Discord にも通知される。

## 異常のとき

**WAL を R2 に送れないと、PostgreSQL は WAL を消せず `pg_wal` が溜まり続けます。ディスクが埋まると DB が止まり、アプリも止まります。** 1 日に数 GB〜20 GB 溜まることがあります。

1. 状況を見る:
   ```bash
   docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres psql -U factoreye -d factoreye -c "select * from pg_stat_archiver"
   docker compose -f docker-compose.cloud.yml exec -T postgres du -sh /var/lib/postgresql/data/pg_wal
   df -h /
   infra/walg/check.sh
   ```
2. 原因を直す（よくある原因: R2 の鍵の失効・変更、R2 の障害、回線の断）。鍵を変えたら `r2.env` を直して `make-conf.sh`（`FORCE=1`）を実行し、`docker compose up -d postgres` で反映する。直れば溜まっていた WAL が自動で順に送られる
3. **基準**: 1 時間以内に直せず、かつ `pg_wal` が 5 GB を超える（またはディスクが 90% を超える）なら、下の「戻し方」でアーカイブを止める（DB を止めないことを優先する）。直ってから `init.sh` で再び有効にし、`backup.sh full` を取り直す

## 戻し方（有効にしたあとで、止めたいとき）

```bash
docker compose -f docker-compose.cloud.yml exec -T -u postgres postgres psql -U factoreye -d factoreye -c "ALTER SYSTEM RESET archive_mode" -c "ALTER SYSTEM RESET archive_command" -c "ALTER SYSTEM RESET archive_timeout"
docker compose -f docker-compose.cloud.yml restart postgres
```

cron の行（`/etc/cron.d/factoreye-walg`）も消す。データのボリュームはそのまま使える。

## 復元

R2 からの復元（管理画面の「R2 から復旧する」、手順と注意）は [`tools/recovery/README.md`](../../tools/recovery/README.md) を参照してください。控え（AWS）の起動は、ecopower の `tools/aws-dr/standby-boot.sh`。

## バージョン

- **WAL-G のバージョンは、本番と DR の控えでそろえる**（復元の互換性）。どちらも `infra/cloud/postgres/Dockerfile` から作ったイメージを使う（バージョンとハッシュを固定。更新するときは両方を変える）
- 本番のイメージを作り直したら、ecopower の `tools/aws-dr/publish-images.sh` で控えのイメージも更新する

## 注意

- `walg.env` には R2 の鍵が入る。Git に入れない。権限は 600
- WAL-G の `delete`（`backup.sh full` の中で実行）は、**専用バケット `factoreye-db` の中だけ**に及ぶ。鍵もこのバケットだけに権限がある
- `check.sh` の `wal-verify` は WAL の欠けを調べる。DB が大きくなったら週 1 回にする
