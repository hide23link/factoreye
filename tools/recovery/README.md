# 復旧ツール（tools/recovery）

FactorEye のバックアップ（`infra/backup.sh` の出力）を、今の DB と見比べながら閲覧・書き出しする Web 画面です。
停電で DB が壊れたとき、不正アクセスでプログラムを壊されたときに、何が失われたかを確かめ、必要なデータを取り出すために使います。

- **FactorEye 本体に依存しません。** backend が起動しなくても、DB が壊れていても使えます
- **Docker があればどこでも動きます**（本番の LXC・ラズパイ・Mac）。違いは設定（`.env`）だけです
- **閲覧・比較では、本番の DB に書き込みません。** 今の DB へは読み取り専用で接続します。バックアップは、コンテナの中の作業用の Postgres に展開してから調べます。書き込むのは「書き戻し」を実行したときだけです（`TARGET_WRITE_DATABASE_URL` を設定した場合だけ使えます）
- **バックアップは読むだけです。** 消したり書き換えたりしません

## できること

| 機能 | 内容 |
|---|---|
| 今の DB の状態 | 接続の可否、スキーマの版（Alembic）、テーブルごとの件数、最後の測定値の時刻、ワークスペースごとの件数 |
| バックアップの一覧と検証 | 読み込み元（ディレクトリ・S3）のバックアップを一覧し、sha256（`.sha256` と照合）と gzip の破損を確かめてから展開する。sha256 が合わないものは、確認してから展開する |
| 比較 | バックアップと今の DB の件数の差、スキーマの版の違い、ワークスペースの増減（今の DB で失われたものを先頭に表示） |
| 閲覧 | テーブルを選び、ワークスペース・期間（測定値・アラーム）で絞って表示する。件数は 10 万件で数えるのを止める |
| 書き出し | 同じ条件で CSV に書き出す（Excel で開ける）。パスワードのハッシュなどは `***` に置き換える。`=` などで始まる文字列は、式として動かないよう先頭に `'` を付ける |
| 書き戻し | 比較の画面で選んだワークスペースについて、今の DB に**無い行だけ**を足す（今ある行は変えない・消さない）。期間を指定すると、測定値・アラームはその期間だけ。下の「書き戻し」 |

DB を丸ごと戻す場合は、`infra/restore.sh` を使います。

## 書き戻し

画面の「書き戻す」タブで、上から順に進めます。

1. **バックアップを選ぶ**: 一覧（日時・種類）から選ぶと、壊れていないかを確かめてから準備します
2. **戻すものを選ぶ**: 今の DB と比べた結果が出ます。今の DB で消えているワークスペースは、最初から選ばれています。期間を絞ると、測定値・アラームはその期間だけになります
3. **内容を確認する**: 選び直すたびに、実際と同じ処理を書き込まずに行い（最後に取り消す）、追加される件数を表示します。外部キー・一意制約の違反（例: 同じメールの別のユーザーが今の DB にいる）も、ここで分かります
4. **書き戻す**: 確認の画面の後、直前に今の DB の控え（`before-merge-<日時>.sql.gz`、一覧では「書き戻し前の控え」）を取ってから、1 つのトランザクションで書き込みます。途中で失敗したら何も書きません

「データを見る・書き出す」タブでは、今の DB・各バックアップの中身を、種類（測定値・アラームなど）・ワークスペース・期間で絞って表示し、CSV で書き出せます。

- 同じ行かどうかは、主キー（UUID）で判定します。測定値は、DB を作り直すと連番の id が重なるため、（センサー, 時刻）で判定します
- 何度実行しても、同じ行が二重に入ることはありません
- ログインの状態（`refresh_tokens`）は戻しません（失効させたログインが復活しないように）
- 発生中のアラームは、今の DB の同じセンサーにも発生中のものがあれば、戻すほうを解除済みにします（発生中はセンサーごとに 1 つが前提のため）。試行の結果に件数が出ます
- self-hosted（OSS 版）の通知設定は id=1 のまま戻します（backend が id=1 を読むため）。今の DB に既にあれば戻しません
- 実行は、手順 3 で確認した件数と、実行の直前にもう一度確かめた件数が一致したときだけ行います（確認の後に今の DB が変わったら、やり直しを求めます）
- 削除の後に、同じメールのユーザーや同じ取り込みキーのセンサーを作り直していると、一意制約の違反で全体が止まります（何も書き込みません）。その場合は、作り直したほうを整理してから戻します
- 直前の控えから DB を丸ごと戻すと、控えを取った後に届いた測定値は失われます
- バックアップと今の DB のスキーマの版（Alembic）が違うときは、書き戻せません

### 引き継ぎからの書き戻し（控え＝AWS が稼いだデータ）

本番が止まっている間、AWS の控えが動き、**増加分の縮小ダンプ**を R2 の `handoff-inc/` に置きます（`tools/aws-dr/handoff.sh`。小さい表は全体、`readings`・`alarms` は起点以降の行だけ。`latest.json` に種類・起点・スキーマの版・台の ID・リージョン）。本番に復帰したら、そのうち**本番に無い行だけ**を足します（今ある行は変えない・消さない。何度実行しても二重にならない）。

- **使い方（普通）**: 本番アプリの管理画面（`/admin`）の「書き戻し」で、一覧 → 試算 → 確認 → 実行。本番アプリ（backend）が、内部ネットワークでこのツールの API を呼びます
- **使い方（直接）**: このツールの画面・API でも行えます。`GET /api/handoffs`（一覧）、`POST /api/handoffs/<handoff-factoreye-日時.sql.gz>/failback`（本文 `{}` が試算、`{"apply": true, "expected_inserted": <試算の合計>}` が実行）
- **設定**: `HANDOFF_SOURCE=s3://<バケット>/<接頭辞>/handoff-inc`（ディレクトリでもよい）。鍵と `S3_ENDPOINT_URL`（R2）は `BACKUP_SOURCE` と同じものを読む（`s3:ListBucket` と `s3:GetObject` だけの鍵）。書き戻しには `TARGET_WRITE_DATABASE_URL` と `TARGET_MODE`（SaaS 版は `saas`）も必要です。backend から呼ぶには、このツールが本番のネットワーク（`factoreye-cloud`。`docker-compose.lxc.yml`）に入っていて、backend の `FAILBACK_RECOVERY_PASSWORD` がここの `RECOVERY_PASSWORD` と同じ値であること
- **処理**: 引き継ぎを取得 → sha256・gzip を検証（壊れていれば使わない）→ 作業用の Postgres に展開 → 書き戻し（試算・実行は上の「書き戻し」と同じ処理: 直前の本番の控え `before-merge-*`、1 つのトランザクション、試算の件数との再確認）→ 展開を消す。対象は縮小ダンプの全ワークスペース（OSS 版の今の DB なら、ワークスペースに属さないデータ）
- **規則**: 測定値は（センサー, 時刻）で重複を避け、id は今の DB で採番する。アラームは id で判定し、今の DB の同じセンサーに発生中のものがあれば、足すほうを解除済みにする。int の連番（OSS 版の通知設定）は、足した最大の id まで進める。親の行が無い子の行（縮小ダンプにセンサーが無い測定値など）は足さない
- **前提**: 本番と控えのスキーマの版（Alembic）が同じこと。違えば書き込まずに 409 で警告します
- **制限**: 控えの稼働中の、既存の行の更新・削除（パスワードの変更など）は戻りません。起点より前に発生して、起点以降に解除されたアラームの変化も戻りません

### OSS 版 ⇄ SaaS 版

バックアップと今の DB の版（OSS 版・SaaS 版）が違っても、所属を付け替えて書き戻せます。今の DB がどちらかは `TARGET_MODE` で指定します（データの中身からは判断しません。空の SaaS 版は OSS 版と見分けられないため）。

| バックアップ → 今の DB | 書き戻し方 |
|---|---|
| OSS 版 → SaaS 版 | 書き戻し先のワークスペースを選び、センサー・測定値・アラーム・ダッシュボード・Webhook・通知設定を、そのワークスペースのものとして入れる。先に SaaS 版で利用者登録をしてワークスペースを作っておく |
| SaaS 版 → OSS 版 | 選んだワークスペースのデータを、OSS 版のデータ（ワークスペースに属さない）として入れる。ユーザー・ワークスペースの行は入れない。通知設定は OSS 版が読む id=1 の 1 行にする |

- センサーの ID と取り込みキーは保ちます（機器の設定を変えずに、そのまま送り続けられます）
- 書き戻し先で、同じ名前のセンサーや同じ取り込みキーがぶつかると、手順 3 で分かり、何も書き込みません
- SaaS 版の Free Tier のセンサー数の上限（10）は確かめません。超える場合は、プランを見直してください

書き込み用の接続は、本番の DB の所有者（`factoreye`）で設定します。書き戻しは閲覧と同じ認証で使えるため、画面は 127.0.0.1（SSH のトンネル経由）か Tailscale だけで開くようにします。

```bash
TARGET_WRITE_DATABASE_URL=postgresql://factoreye:<POSTGRES_PASSWORD>@postgres:5432/factoreye
```

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

書き戻しを使う場合は、`.env` に `TARGET_MODE=oss` を設定します（SaaS 版は `TARGET_MODE=saas`）。

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
| `TARGET_WRITE_DATABASE_URL` | なし | 書き戻しに使う、今の DB への書き込みできる接続。無ければ書き戻しは使えない。設定するには `TARGET_DATABASE_URL` と `TARGET_MODE` も必要（無いと起動時にエラー） |
| `TARGET_MODE` | なし（書き戻しを使うなら必須） | 今の DB が SaaS 版なら `saas`、OSS 版なら `oss` |
| `HANDOFF_SOURCE` | なし | 控え（AWS）が置いた縮小ダンプの読み込み元（`s3://<バケット>/<接頭辞>/handoff-inc` かディレクトリ）。無ければ、引き継ぎからの書き戻しは使えない |
| `AWS_ACCESS_KEY_ID` など | なし | S3 の認証。`s3:ListBucket` と `s3:GetObject` だけの鍵にする |
| `S3_ENDPOINT_URL` | なし | S3 互換のサービス（MinIO など） |
| `BACKUP_GID` | `0` | バックアップのファイル（640）のグループ。コンテナはこのグループで読む |
| `RECOVERY_BIND` / `RECOVERY_PORT` | `127.0.0.1` / `8090` | 画面の待ち受け |
| `RECOVERY_CACHE_DIR` | `/var/lib/recovery/cache` | S3 から取ったバックアップの置き場（コンテナ内） |
| `RECOVERY_SNAPSHOT_DIR` | `/var/lib/recovery/snapshots` | 書き戻しの直前の控え（`before-merge-*.sql.gz`）の置き場（コンテナ内） |
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
