# バックアップ・リストア

`docs/architecture.md` §11 運用（バックアップ） の実装。PostgreSQLを`pg_dump`で日次バックアップし、
7日より古いファイルは自動削除する。各ファイルの隣に sha256（`.sha256`）を書く。

- 設定ファイル（`.env`・管理者ファイル・cloudflared の設定）も、暗号化して一緒に保存できる（下の「設定ファイルの控え」）
- 本番の外にも控えを置く: S3 に送る（`offsite-s3.sh`）か、ラズパイなどから取りに行く（`offsite-pull.sh`）
- 中身の確認・比較・書き出しは、復旧ツール（[`tools/recovery/`](../tools/recovery/README.md)）で行う

## セットアップ（本番運用者向け）

1. docker-composeでスタックが起動していること（`docker compose up -d`）
2. cronに登録する（毎日午前3時に実行）:

   ```bash
   crontab -e
   # 以下の行を追加（パスは実際のクローン先に合わせる）
   0 3 * * * cd /opt/factoreye && ./infra/backup.sh >> /opt/factoreye/backups/backup.log 2>&1
   ```

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

```bash
./infra/restore.sh backups/factoreye-20261002-030000.sql.gz
```

`restore.sh`は**空のDB**への復元のみを想定している（`pg_dump`の出力に`--clean`を付けていないため、
既存データが残っていると「既に存在する」エラーで失敗する＝安全側に倒れる）。本番データが入った
DBに丸ごと復元したい場合は、先にそのDB/ボリュームを作り直してから実行すること。

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

### ラズパイなどから取りに行く（`offsite-pull.sh`）

取りに行く側の cron で実行する。本番側には、読むだけ・`backups/` だけに限った鍵を登録する。
取りに行く側は、本番と同じ Tailscale ネットワークに参加している必要がある（本番の ufw は SSH を
LAN（192.168.11.0/24）と Tailscale だけに許可しているため。LAN 上の別サブネットからは届かない）。

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
- バックアップのファイルは、ほかの利用者が読めない権限（640）で作る（復旧ツールはグループの権限で読む）。`backups/`は
  `.gitignore`済みでリポジトリにはコミットされない
