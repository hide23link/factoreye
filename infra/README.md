# バックアップ・リストア

[`docs/architecture.md`](../docs/architecture.md) §11 運用（バックアップ）の実装。PostgreSQLを`pg_dump`で日次バックアップし、
7日より古いファイルは自動削除する。各ファイルの隣に sha256（`.sha256`）を書く。

- 設定ファイル（`.env`・管理者ファイル・cloudflared の設定）も、暗号化して一緒に保存できる（下の「設定ファイルの控え」）
- 本番の外にも控えを置く: S3 か Cloudflare R2 に送る（`offsite-s3.sh`）か、ラズパイなどから取りに行く（`offsite-pull.sh`）
- 中身の確認・比較・書き出しは、復旧ツール（[`tools/recovery/`](../tools/recovery/README.md)）で行う

## セットアップ（本番運用者向け）

1. docker-composeでスタックが起動していること（OSS 版は `docker compose up -d`、クラウド版は `docker compose -f docker-compose.cloud.yml up -d`）
2. cronに登録する（毎日午前3時に実行）。スクリプトは `docker compose exec` を使うため、
   **クラウド版では `COMPOSE_FILE=docker-compose.cloud.yml` が必須**（無いと既定の `docker-compose.yml`
   を見て、postgres が見つからず失敗する）。OSS 版は `COMPOSE_FILE` は不要:

   ```bash
   crontab -e
   # 以下のどちらかの行を追加（パスは実際のクローン先に合わせる）
   # クラウド版（本番）
   0 3 * * * cd /opt/factoreye && COMPOSE_FILE=docker-compose.cloud.yml ./infra/backup.sh >> /opt/factoreye/backups/backup.log 2>&1
   # OSS 版
   0 3 * * * cd /opt/factoreye && ./infra/backup.sh >> /opt/factoreye/backups/backup.log 2>&1
   ```

   設定ファイルの控えも取る場合は、下の「設定ファイルの控え」の行（`BACKUP_PASSPHRASE_FILE` 付き）を使う。

3. バックアップ先ディレクトリや保持日数を変えたい場合は環境変数で上書きする:

   ```bash
   BACKUP_DIR=/mnt/external/factoreye-backups BACKUP_RETENTION_DAYS=14 ./infra/backup.sh
   ```

   （何も指定しなければ、リポジトリ直下の`backups/`に7日分保持する）

## 動作確認

```bash
./infra/backup.sh
ls -lh backups/
```

## リストア

先に、**postgres のサービスだけ**を起動する（backend を起動すると、マイグレーションで空でなくなり、
復元が「既に存在する」エラーで失敗する）。`restore.sh` もバックアップと同じく `docker compose exec` を
使うため、クラウド版では `COMPOSE_FILE` を付ける。

```bash
# クラウド版（OSS 版は COMPOSE_FILE の指定は不要）
export COMPOSE_FILE=docker-compose.cloud.yml
docker compose up -d postgres      # postgres だけ。healthy になるまで待つ（docker compose ps）
./infra/restore.sh backups/factoreye-20261002-030000.sql.gz
docker compose up -d               # 復元後に全体を起動する
```

`restore.sh`は**空のDB**への復元のみを想定している（`pg_dump`の出力に`--clean`を付けていないため、
既存データが残っていると「既に存在する」エラーで失敗する＝安全側に倒れる）。本番データが入った
DBに丸ごと復元したい場合は、先にそのDB/ボリュームを作り直してから実行すること。

復元すると、復旧ツール用の読み取り専用ロール（`factoreye_readonly`）は、無ければログイン不可の
状態で自動的に作られる（バックアップに含まれる GRANT を通すため）。復旧ツールで使う場合は、
[`tools/recovery/README.md`](../tools/recovery/README.md) の「読み取り専用のロール」の手順で
パスワードを設定し直すこと。

### 復旧の訓練（本番以外で行うこと）

本番を壊さずに、復元の手順そのものが動くことを定期的に確かめる。

```bash
# 1. 空の Postgres を用意する（本番とは別の compose project 名にする）
COMPOSE_PROJECT_NAME=factoreye-restore-drill docker compose up -d postgres

# 2. バックアップ（本番の外の控えなど）から復元する
COMPOSE_PROJECT_NAME=factoreye-restore-drill ./infra/restore.sh <バックアップファイル>

# 3. 確かめる（テーブル数・スキーマ版・件数など）
docker compose exec postgres psql -U factoreye factoreye -c '\dt'
docker compose exec postgres psql -U factoreye factoreye -c 'SELECT version_num FROM alembic_version'

# 4. 後片付け（-v を忘れると、次の訓練が古いデータの上に重なって誤った結果になる）
COMPOSE_PROJECT_NAME=factoreye-restore-drill docker compose down -v
```

復元後は、テーブル数・スキーマ版・件数に加えて、`factoreye_readonly` の権限が復元されることも確かめる。後片付け（`down -v`）を忘れて前の試行のボリュームが残ったまま復元すると、`type already exists` 等のエラーになる（空の DB を前提にする `restore.sh` の設計どおり、安全側に失敗する）。

## 設定ファイルの控え

DB だけを戻しても、`.env`（DB のパスワード・JWT の鍵）や管理者ファイルが無いと、プログラムを作り直したときに復旧できない。
合言葉のファイルを作り、cron の行に `BACKUP_PASSPHRASE_FILE` を足す。

```bash
openssl rand -hex 32 > /root/.factoreye-backup-pass && chmod 600 /root/.factoreye-backup-pass
# 合言葉は、本番の外（パスワード管理ツールなど）にも必ず控える。本番が失われると、これが無ければ開けない
```

```bash
0 3 * * * cd /opt/factoreye && COMPOSE_FILE=docker-compose.cloud.yml BACKUP_PASSPHRASE_FILE=/root/.factoreye-backup-pass ./infra/backup.sh >> /opt/factoreye/backups/backup.log 2>&1
```

保存するファイルは `BACKUP_CONFIG_FILES`（空白区切り。既定 `.env admin/admins.txt /etc/cloudflared/config.yml`）で変えられる。

### 設定ファイルの復元

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:<合言葉のファイル> \
  -in factoreye-<日時>-config.tar.gz.enc | tar -tzvf -    # 中身の確認。展開は -tzvf を -xzf - -C <展開先> に
```

## 本番の外への控え

本番が乗っ取られても控えを消されないように、本番に渡す権限を絞る。どちらか（または両方）を使う。

### S3 に送る（`offsite-s3.sh`）

1. バケットを作り、**バージョニングを有効**にする（上書き・削除されても前の版が残る）。古い版の削除はライフサイクルのルールで行う（例: 90 日）
2. 本番用の IAM ユーザーを作り、**追加だけ**の権限にする:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "s3:PutObject",
       "Resource": "arn:aws:s3:::<バケット>/factoreye/*"
     }]
   }
   ```

3. 認証情報を `/opt/factoreye/.offsite-s3.env`（権限 600、Git 管理外）に書く:

   ```bash
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   AWS_DEFAULT_REGION=ap-northeast-1
   ```

4. cron の行に `OFFSITE_S3_URI=s3://<バケット>/factoreye` を足す。`backup.sh` が作ったファイルを送る（aws CLI は Docker のイメージで動かすので、ホストに入れなくてよい）

復旧ツールで S3 から読むときは、別の IAM ユーザー（`s3:ListBucket` と `s3:GetObject` だけ）を使う。

### Cloudflare R2 に送る（`offsite-s3.sh` をそのまま使う）

R2 は S3 互換なので、スクリプトは変えずに、認証情報のファイルで宛先を R2 に向ける。保管料は 10GB まで無料で、外向き通信も無料（最新の料金は Cloudflare の料金ページで確認する）。

1. Cloudflare のダッシュボードの R2 で、バケットを作る（例: `factoreye-backup`。場所のヒントはアジア太平洋）
2. R2 の API トークンを作る。権限は「Object Read & Write」、対象は**このバケットだけ**。Access Key ID・Secret Access Key・アカウント ID を控える。R2 のトークンは、S3 のような「追加だけ」にできない（削除もできる）
3. **削除・上書きを防ぐため、バケットのロックを設定する**。`factoreye/` の接頭辞に、保持期間（例: 30 日）のルールを付ける。トークンが盗まれても、期間内は消せない（[Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)）。古い控えの削除は、ライフサイクルのルール（例: 90 日）で行う。ロックのほうが優先される
4. 認証情報を `/opt/factoreye/.offsite-s3.env`（権限 600、Git 管理外）に書く:

   ```bash
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   AWS_DEFAULT_REGION=auto
   AWS_ENDPOINT_URL=https://<アカウントID>.r2.cloudflarestorage.com
   ```

5. cron の行に `OFFSITE_S3_URI=s3://<バケット>/factoreye` を足す
6. 最初の 1 回は手で実行し、R2 にファイルが入ったことと、`.sha256` の一致を確かめる

注意:
- `AWS_CLI_IMAGE` は **2.23 より前の版**のままにする（既定の 2.17.0）。2.23 以降は、既定のチェックサムの扱いが R2 と合わない（Cloudflare の aws CLI の案内）。
- 復旧ツールで読むときは、別のトークン（「Object Read only」）を使う。
- 実機の R2 での送信は、まだ確認していない（`AWS_ENDPOINT_URL` が使われることは、ローカルで確認した）。

### AWS の控え（パイロットライト）

平常時は、AWS に EC2・EBS・パブリック IPv4 を置かない（月 $0〜2）。災害時だけ、次の手順で立ち上げる。**まだ訓練していない手順の案**であり、実際に動かして直す。

1. 準備（平常時）: 設定済みの EC2（OS・Docker・イメージ。**秘密情報とデータは入れない**）の AMI（スナップショット）を 1 つ作っておく（暗号化。月 $0.2〜0.4）。更新したら作り直す
2. 災害時: AMI から EC2（スポットまたはオンデマンド）を起動し、EBS を足す
3. R2 から最新のバックアップを取り、`restore.sh` で戻す（設定ファイルは、合言葉で復号して戻す）
4. Cloudflare Tunnel の向き先を、AWS 側のトンネルに切り替える
5. 復旧後、`/health` と `/api/info` を確かめる

目安は復旧に 30〜60 分、欠損は最大でバックアップの間隔ぶん（日次なら 24 時間）。EBS は台が止まると使えないので、データの控えは R2 に置く。

### ラズパイなどから取りに行く（`offsite-pull.sh`）

取りに行く側の cron で実行する。本番側には、読むだけ・`backups/` だけに限った鍵を登録する。
取りに行く側は、本番と同じ Tailscale ネットワークに参加している必要がある（本番の ufw は SSH を
LAN と Tailscale だけに許可しているため。LAN 上の別サブネットからは届かない）。

1. 取りに行く側で、専用のディレクトリに鍵を作る（`~/.ssh` は所有者が違う等で書けないことが
   あるため、自分専用の場所にする）:

   ```bash
   mkdir -p ~/factoreye-offsite && chmod 700 ~/factoreye-offsite
   ssh-keygen -t ed25519 -f ~/factoreye-offsite/factoreye_backup -N ""
   ```

2. 本番の `/root/.ssh/authorized_keys` に、制限を付けて登録する（`rrsync -ro` で読み取り専用・ディレクトリ固定）:

   ```
   command="rrsync -ro /opt/factoreye/backups",restrict ssh-ed25519 AAAA... factoreye-backup
   ```

3. `infra/offsite-pull.sh` を取りに行く側に置き、`chmod +x` する
4. 取りに行く側の cron（環境変数は鍵と同じディレクトリに合わせる）:

   ```bash
   30 3 * * * OFFSITE_SOURCE=root@<本番の Tailscale の IP> OFFSITE_SSH_KEY=$HOME/factoreye-offsite/factoreye_backup OFFSITE_DIR=$HOME/factoreye-offsite-backups $HOME/factoreye-offsite/offsite-pull.sh >> $HOME/factoreye-offsite/pull.log 2>&1
   ```

- ホスト鍵は初回の実行時に自動で登録する（`OFFSITE_KNOWN_HOSTS`、既定は鍵と同じディレクトリ）。
  本物かどうかは、本番側で `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` の fingerprint と、
  実行ログに出る fingerprint を見比べて確かめること
- 既定は `$HOME/factoreye-offsite-backups`、90 日保持（`OFFSITE_RETENTION_DAYS`）。本番の 7 日
  より長く持ち、壊れたことに気づくのが遅れても、壊れる前の版が残るようにする
- 既にあるファイルは取り直さない。取ってきたファイルは `.sha256` で検証し、合わなければ終了コード 1 で知らせる

## 注意

- このスクリプトはcompose project名に依存しない（`docker compose exec <service名>`を使うため、
  ディレクトリ名やランナーの構成に依存しない）
- バックアップのファイルは、書き込み中は `.partial-*` に書いてから名前を変える（書きかけを外部の取得や復旧ツールが拾わないように）。
- バックアップのファイルは、ほかの利用者が読めない権限（640）で作る（復旧ツールはグループの権限で読む）。`backups/`は
  `.gitignore`済みでリポジトリにはコミットされない

## クラウド版の DB のバックアップ（WAL-G）

クラウド版は、毎晩の `pg_dump` をやめ、**WAL の追記とベースバックアップを R2 に送る**。手順・cron・確認は `infra/walg/README.md`。`infra/backup.sh` は、`BACKUP_DB=off` で、**設定ファイルの暗号化バックアップだけ**を作る（DR の控えの起動に必要）。OSS 版（`docker-compose.yml`）は、従来どおり `pg_dump`（`BACKUP_DB` の既定は `on`）。

