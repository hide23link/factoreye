# 運用のスクリプト（バックアップ・復元・自動デプロイ）

[`docs/architecture.md`](../docs/architecture.md) §11 運用 の実装です。配布版（`install/`）を使う場合は、`./factoreye.sh backup` が同じことをするので、ここを直接使う必要はありません。

| ファイル | 内容 |
|---|---|
| `backup.sh` | DB の日次バックアップ（`pg_dump`。隣に `.sha256`）。保持 7 日。設定ファイルの暗号化バックアップも取れる |
| `restore.sh` | `backup.sh` のバックアップを**空の DB** に戻す |
| `offsite-s3.sh` | バックアップを S3・Cloudflare R2 などの S3 互換の置き場に送る |
| `offsite-pull.sh` | 別のマシン（ラズパイなど）から、本番のバックアップを取りに行く |
| `check-migration-space.sh` | スキーマの版が変わる更新の前に、DB のディスクの空きを確かめる |
| `cloud/` | クラウド版の自動デプロイ（`deploy-pull.sh` と systemd の timer）・サーバーの初期設定・WAL-G 入りの PostgreSQL |
| `walg/` | クラウド版の DB のバックアップ（WAL-G）。[README](walg/README.md) |
| `lan-ingest/` | LAN 向けの取り込み専用の窓口。[README](lan-ingest/README.md) |
| `tests/` | 上のスクリプトの試験（Docker・ネットワーク不要） |

中身の確認・比較・書き出し・無い行だけの書き戻しは、復旧ツール（[`tools/recovery/`](../tools/recovery/README.md)）で行います。

## バックアップ

cron に登録します（毎日 3 時の例。パスはクローン先に合わせる）。スクリプトは `docker compose exec` を使うので、クラウド版は `COMPOSE_FILE=docker-compose.cloud.yml` を付けます。

```bash
# OSS 版
0 3 * * * cd /opt/factoreye && ./infra/backup.sh >> /opt/factoreye/backups/backup.log 2>&1
# クラウド版
0 3 * * * cd /opt/factoreye && COMPOSE_FILE=docker-compose.cloud.yml ./infra/backup.sh >> /opt/factoreye/backups/backup.log 2>&1
```

| 環境変数 | 既定 | 内容 |
|---|---|---|
| `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` | `backups/` / `7` | 置き場と保持日数 |
| `BACKUP_PASSPHRASE_FILE` | なし | 合言葉のファイル。設定すると、設定ファイル（`BACKUP_CONFIG_FILES`、既定 `.env admin/admins.txt /etc/cloudflared/config.yml`）も暗号化して保存する |
| `BACKUP_DB` | `on` | `off` で DB のダンプを取らず、設定ファイルだけを保存する（WAL-G を使うクラウド版） |
| `OFFSITE_S3_URI` | なし | 設定すると、作ったファイルを `offsite-s3.sh` で送る |

### 設定ファイルの控え

DB だけを戻しても、`.env`（DB のパスワード・JWT の鍵）や管理者ファイルが無いと復旧できません。合言葉のファイルを作り（`openssl rand -hex 32 > /root/.factoreye-backup-pass && chmod 600 …`）、合言葉は本番の外（パスワード管理ツールなど）にも控えます。中身の確認は次のとおりです。

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:<合言葉のファイル> \
  -in factoreye-<日時>-config.tar.gz.enc | tar -tzvf -    # 展開は -tzvf を -xzf - -C <展開先> に
```

## 復元

先に **postgres だけ**を起動します（backend を起動すると移行で DB が空でなくなり、復元が「既に存在する」で失敗します。安全側に止まる設計です）。

```bash
docker compose up -d postgres      # healthy になるまで待つ（クラウド版は COMPOSE_FILE を付ける）
./infra/restore.sh backups/factoreye-20261002-030000.sql.gz
docker compose up -d
```

復元すると、復旧ツール用の読み取り専用のロール `factoreye_readonly` が、無ければログインできない状態で作られます。復旧ツールで使うときは、[`tools/recovery/README.md`](../tools/recovery/README.md) の「読み取り専用のロール」でパスワードを設定し直します。

復元の訓練は、本番とは別の compose project 名で行います（`COMPOSE_PROJECT_NAME=factoreye-restore-drill docker compose up -d postgres` → `restore.sh` → 確認 → `down -v`）。

## 本番の外への控え

- **S3 に送る**（`offsite-s3.sh`）: バケットのバージョニングを有効にし、本番に渡す鍵は `s3:PutObject` だけにします。認証情報は `.offsite-s3.env`（権限 600、Git 管理外）に書きます。Cloudflare R2 も、`AWS_ENDPOINT_URL` を足せば同じスクリプトで送れます（R2 はバケットのロックで削除を防ぐ。`AWS_CLI_IMAGE` は 2.23 より前の版のまま）
- **取りに行く**（`offsite-pull.sh`）: 取りに行く側で鍵を作り、本番の `authorized_keys` に `command="rrsync -ro /opt/factoreye/backups",restrict` を付けて登録します（読むだけ・`backups/` だけ）。接続先は `OFFSITE_SOURCE` で必ず渡します。既定で 90 日保持し、`.sha256` で検証します。初回に表示されるホスト鍵の fingerprint を、本番側の `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` と見比べて確かめます

## 本番の自動デプロイ（クラウド版）

`main` が変わると、本番のサーバーが 1 分以内に自分で更新します。**サーバーから外へ見に行くだけ**で、外から入る口（SSH・自己ホスト型のランナー）は要りません（公開リポジトリで自己ホスト型のランナーを本番に置くと、外部の人の PR の中身が本番で動くおそれがあるため）。

- `cloud/deploy-pull.sh`: `git fetch` → 前回デプロイした版から `backend/`・`frontend/`・`infra/cloud/`・`docker-compose.cloud.yml` が変わっていれば、変わったサービスだけを作り直す。失敗したら記録せず、次の回にもう一度試す。手元でコードが書き換えられていたら止まる
- `cloud/factoreye-deploy.service` / `.timer`: systemd が 60 秒ごとに実行する。ログは `journalctl -u factoreye-deploy`
- 導入: 2 つの unit を `/etc/systemd/system/` に置き、`systemctl daemon-reload && systemctl enable --now factoreye-deploy.timer`。止めるときは `systemctl disable --now factoreye-deploy.timer`
- 試験: `infra/tests/test-deploy-pull.sh`

## スキーマの版が変わる更新

1. `./infra/check-migration-space.sh` で DB のディスクの空きを確かめる（足りなければ終了コード 1）
2. 適用の直前にバックアップを取る（WAL-G のクラウド版も、`BACKUP_DB=on` を付けて 1 回取る）
3. アプリを止めてから更新する（起動時の `alembic upgrade head` が移行する）
4. 適用の直後にもバックアップを取る（復旧ツールの書き戻しは、同じ版どうしでしか使えないため）

## 注意

- バックアップのファイルは、書き込み中は `.partial-*` に書いてから名前を変えます（書きかけを拾わないため）。権限は 640 で、`backups/` は `.gitignore` 済みです
