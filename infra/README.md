# バックアップ・リストア

`docs/factoreye-architecture.md` §バックアップ の実装。PostgreSQLを`pg_dump`で日次バックアップし、
7日より古いファイルは自動削除する。

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

## 注意

- このスクリプトはcompose project名に依存しない（`docker compose exec <service名>`を使うため、
  ディレクトリ名や自宅LXC self-hosted runner移行後も変更不要）
- バックアップファイル自体の保護（暗号化・オフサイト保管等）は運用者の責任範囲。`backups/`は
  `.gitignore`済みでリポジトリにはコミットされない
