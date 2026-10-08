# 復旧ツール（tools/recovery）

FactorEye のバックアップ（`infra/backup.sh` の出力）を、今の DB と見比べながら閲覧・書き出しする Web 画面です。
停電で DB が壊れたとき、不正アクセスでプログラムを壊されたときに、何が失われたかを確かめ、必要なデータを取り出すために使います。

- **FactorEye 本体に依存しません。** backend が起動しなくても、DB が壊れていても使えます
- **Docker があればどこでも動きます**（本番の LXC・ラズパイ・Mac）。違いは設定（`.env`）だけです
- **本番の DB には書き込みません。** 今の DB へは読み取り専用で接続します。バックアップは、コンテナの中の作業用の Postgres に展開してから調べます
- **バックアップは読むだけです。** 消したり書き換えたりしません

## できること

| 機能 | 内容 |
|---|---|
| 今の DB の状態 | 接続の可否、スキーマの版（Alembic）、テーブルごとの件数、最後の測定値の時刻、ワークスペースごとの件数 |
| バックアップの一覧と検証 | 読み込み元（ディレクトリ・S3）のバックアップを一覧し、sha256（`.sha256` と照合）と gzip の破損を確かめてから展開する。sha256 が合わないものは、確認してから展開する |
| 比較 | バックアップと今の DB の件数の差、スキーマの版の違い、ワークスペースの増減（今の DB で失われたものを先頭に表示） |
| 閲覧 | テーブルを選び、ワークスペース・期間（測定値・アラーム）で絞って表示する。件数は 10 万件で数えるのを止める |
| 書き出し | 同じ条件で CSV に書き出す（Excel で開ける）。パスワードのハッシュなどは `***` に置き換える。`=` などで始まる文字列は、式として動かないよう先頭に `'` を付ける |

データを今の DB に戻す（追記・マージ）機能は、次の段階で追加します。それまでは、CSV で取り出すか、`infra/restore.sh` で DB を丸ごと戻します。

## 起動

```bash
cd tools/recovery
cp .env.example .env    # RECOVERY_PASSWORD などを設定する（権限 600 にする）
```

### 本番の LXC（今の DB と見比べる）

```bash
docker compose -f docker-compose.yml -f docker-compose.lxc.yml up -d --build
```

- `BACKUP_DIR` の既定は `../../backups`（`/opt/factoreye/backups`）
- 今の DB は、読み取り専用のロールで接続する（下の「読み取り専用のロール」）。`TARGET_DATABASE_URL=postgresql://factoreye_readonly:<パスワード>@postgres:5432/factoreye`
- 画面は `127.0.0.1:8090` だけで待ち受けます。Mac からは `ssh -L 8090:localhost:8090 factoreye` を開いてから `http://localhost:8090` を開きます。Tailscale から直接開く場合は `.env` に `RECOVERY_BIND=<LXC の Tailscale の IP>` を設定します
- FactorEye 本体のデプロイ（`deploy-cloud`）とは別に動きます。本体を作り直しても止まりません

### OSS 版（自分のサーバーで FactorEye を動かしている場合）

SaaS 版と同じものが使えます（DB の構成は同じで、ワークスペースの無いセンサーは「（self-hosted）」の行に出ます）。
OSS 版の compose（`docker-compose.yml`）はネットワーク名が `factoreye` なので、それを指定します。

```bash
FACTOREYE_NETWORK=factoreye docker compose -f docker-compose.yml -f docker-compose.lxc.yml up -d --build
```

`TARGET_DATABASE_URL` は `postgresql://factoreye_readonly:<パスワード>@postgres:5432/factoreye`。バックアップは `infra/backup.sh`（OSS 版はそのまま。`COMPOSE_FILE` の指定は要りません）で取ったものを使います。

### ラズパイ・Mac（本番が使えないとき）

```bash
# 手元のディレクトリ（infra/offsite-pull.sh で取ってきたもの）
BACKUP_DIR=/srv/factoreye-backups docker compose up -d --build
# S3 の場合は .env に BACKUP_SOURCE=s3://<バケット>/<接頭辞> と、読むだけの鍵を設定する
```

本番が失われた後は `TARGET_DATABASE_URL` を空にします（バックアップだけを扱います）。新しく立てた DB と見比べる場合は、そこを指定します。

### 読み取り専用のロール（本番の DB に作る）

今の DB への接続は、ツールの側でも読み取り専用にしていますが、DB の側でも書けないロールを使います。

```sql
CREATE ROLE factoreye_readonly LOGIN PASSWORD '<openssl rand -hex 24 で作った値>';
GRANT CONNECT ON DATABASE factoreye TO factoreye_readonly;
GRANT USAGE ON SCHEMA public TO factoreye_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO factoreye_readonly;
-- 今後のマイグレーションで増えるテーブルも読めるようにする
ALTER DEFAULT PRIVILEGES FOR ROLE factoreye IN SCHEMA public GRANT SELECT ON TABLES TO factoreye_readonly;
```

実行は `docker compose -f docker-compose.cloud.yml exec postgres psql -U factoreye factoreye`。

## 設定

| 変数 | 既定 | 内容 |
|---|---|---|
| `RECOVERY_PASSWORD` | （必須） | 画面の Basic 認証。12 文字以上 |
| `RECOVERY_USERNAME` | `admin` | 画面の Basic 認証のユーザー名 |
| `BACKUP_SOURCE` | `/backups` | 読み込み元。ディレクトリか `s3://<バケット>/<接頭辞>` |
| `BACKUP_DIR` | `../../backups` | compose で `/backups` に見せる手元のディレクトリ（読み取り専用） |
| `TARGET_DATABASE_URL` | なし | 今の DB。読み取り専用で接続する |
| `AWS_ACCESS_KEY_ID` など | なし | S3 の認証。`s3:ListBucket` と `s3:GetObject` だけの鍵にする |
| `S3_ENDPOINT_URL` | なし | S3 互換のサービス（MinIO など） |
| `BACKUP_GID` | `0` | バックアップのファイル（640）のグループ。コンテナはこのグループで読む |
| `RECOVERY_BIND` / `RECOVERY_PORT` | `127.0.0.1` / `8090` | 画面の待ち受け |
| `SCRATCH_DSN` | コンテナが自動で設定 | 作業用の Postgres。コンテナの外で動かす場合だけ指定する |

## 書き換えられたバックアップへの備え

乗っ取られた本番では、バックアップと `.sha256` を一緒に作り直せます。そのため sha256 の一致だけを頼りにせず、展開そのものを安全にしています。

- psql のメタコマンド（`\!` など）を止める（先頭に乱数の鍵で `\restrict` を掛け、行頭のメタコマンドは拒否する）
- 管理者ではないロール（`bk_restorer`）で流し込む（`COPY ... PROGRAM` などのサーバー側のコマンド実行ができない）。所有者が管理者のロールになっているバックアップは展開しない
- psql と作業用の Postgres には、秘密の環境変数（`TARGET_DATABASE_URL`・AWS の鍵・`RECOVERY_PASSWORD`）を渡さない
- 展開は一時的な名前（`bktmp_*`）で行い、成功してから `bk_*` に変える（途中で落ちたものを展開済みに見せない）

## 注意

- 作業用の Postgres は本番と同じ 15 系です。本番の Postgres の版を上げたら、`Dockerfile` も合わせて上げます（新しい版のダンプは古い版に流し込めません）
- 今の DB への 1 つの SQL は 30 秒で打ち切る（CSV の書き出しは 10 分）。100 万件を超えるテーブルの件数は、統計の推定値を表示する
- 展開したバックアップは、ボリューム `recovery-data` に残ります。使い終わったら画面の「作業用 DB から消す」で消します
- 設定ファイルの控え（`factoreye-*-config.tar.gz.enc`）は画面では扱いません。展開は `infra/README.md` の「設定ファイルの復元」を参照

## 開発

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest && .venv/bin/mypy . && .venv/bin/ruff check .
```

DB を使うテストは、`TEST_SCRATCH_DSN`（作業用の Postgres の管理用 DB。例: `postgresql://factoreye:password@localhost:5432/postgres`）と `psql` が必要です。無ければ飛ばされます。テストは `bk_*` の DB を作って消すため、本番や開発用の DB は指定しないでください。
