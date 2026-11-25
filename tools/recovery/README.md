# 復旧ツール（tools/recovery）

FactorEye のバックアップ（`infra/backup.sh` の出力・WAL-G のバックアップ）を、今の DB と見比べながら閲覧・書き出し・書き戻しする Web 画面です。停電で DB が壊れたとき、不正アクセスでプログラムを壊されたときに、何が失われたかを確かめ、必要なデータを取り出すために使います。

- **FactorEye 本体に依存しません。** backend が起動しなくても、DB が壊れていても使えます。Docker があればどこでも動きます
- **閲覧・比較では、今の DB に書き込みません。** 今の DB へは読み取り専用で接続し、バックアップはコンテナの中の作業用の PostgreSQL に展開して調べます。書き込むのは「書き戻し」を実行したときだけです（`TARGET_WRITE_DATABASE_URL` を設定した場合だけ）
- **バックアップは読むだけです。** 消したり書き換えたりしません

DB を丸ごと戻すときは `infra/restore.sh` を使います（[`infra/README.md`](../../infra/README.md)）。

## できること

| 機能 | 内容 |
|---|---|
| 今の DB の状態 | 接続の可否、スキーマの版（Alembic）、テーブルごとの件数、最後の測定値の時刻、ワークスペースごとの件数 |
| バックアップの一覧と検証 | ディレクトリ・S3 のバックアップを一覧し、sha256 と gzip の破損を確かめてから展開する |
| 比較 | バックアップと今の DB の件数の差、スキーマの版の違い、ワークスペースの増減 |
| 閲覧・書き出し | テーブル・ワークスペース・期間で絞って表示し、CSV に書き出す（パスワードのハッシュなどは伏せ、式として動く文字は無害にする） |
| 書き戻し | 選んだワークスペース（・期間）について、今の DB に**無い行だけ**を足す。今ある行は変えない・消さない |
| R2 から復旧する | WAL-G のバックアップ（ベース＋WAL）を作業用の領域に復元し、そこから無い行だけを足す（SaaS 版の管理画面 `/admin` から使う） |

### 書き戻しの決まり

- 「内容を確認する」で、書き込まずに同じ処理を行い（最後に取り消す）、追加される件数と制約の違反を出します。実行は、その件数と、実行の直前にもう一度確かめた件数が一致したときだけです
- 実行の直前に今の DB の控え（`before-merge-<日時>.sql.gz`）を取り、1 つのトランザクションで書きます。途中で失敗したら何も書きません。**書き戻した行だけを消す手順はありません**
- 同じ行かは主キーで判定します（測定値は センサー と 時刻）。何度実行しても二重になりません。ログインの状態（`refresh_tokens`）は戻しません
- バックアップと今の DB のスキーマの版が違うときは、書き戻せません
- OSS 版 ⇄ SaaS 版の間でも、所属を付け替えて書き戻せます（今の DB がどちらかは `TARGET_MODE` で指定）。センサーの ID と取り込みキーは保ちます

### R2 から復旧する

本番が消えた、またはデータが一部しか無いときに、WAL-G のバックアップから、本番に無い行だけを足します。最新のベースを作業用の領域に展開し、一時的な PostgreSQL（unix ソケットだけ）で WAL を最新まで再生し、それを書き戻しの元にします。使う WAL-G のコマンドは読み取りだけ（`backup-list`・`backup-fetch`・`wal-fetch`）です。

- 設定は `./walg/walg.env`（[`infra/walg/walg.env.example`](../../infra/walg/walg.env.example) と同じ形式。権限 600、Git 管理外）。compose が `/etc/recovery/walg` に読み取り専用で渡す
- コンテナは uid 10001 で動くので、`walg.env` は (a) 所有者を 10001・権限 600 にするか、(b) 権限 640 でグループを `BACKUP_GID` に合わせる。グループを別にしたいときだけ、`.env` に `WALG_GID` を書き `docker-compose.walg.yml` を重ねる。読めないときも起動はし、この機能だけが無効になって画面に理由が出る
- 作業用の領域（`R2_RESTORE_DIR`）に、本番の DB と同じ大きさの空きが要る。足りなければ始める前に止まる
- 流れ（SaaS 版の管理画面 `/admin` の「R2 から復旧する」）: 復元を始める（数分。裏で進む）→ 試算 → 確認 → 実行 → 結果。終わったら「作業用の復元を消す」
- 本番とバックアップのスキーマの版が違うときは、書き込まずに止まる。本番を、バックアップと同じ版のコードで起動し直す

## 起動

```bash
cd tools/recovery
cp .env.example .env    # RECOVERY_PASSWORD などを設定する（権限 600）
```

| 動かす場所 | コマンド |
|---|---|
| FactorEye と同じサーバー（今の DB と見比べる。クラウド版） | `docker compose -f docker-compose.yml -f docker-compose.lxc.yml up -d --build` |
| 同上（OSS 版。ネットワーク名が `factoreye`） | `FACTOREYE_NETWORK=factoreye docker compose -f docker-compose.yml -f docker-compose.lxc.yml up -d --build`（書き戻すなら `.env` に `TARGET_MODE=oss`） |
| 別のマシン（本番が使えないとき） | `BACKUP_DIR=/srv/factoreye-backups docker compose up -d --build`（S3 なら `.env` に `BACKUP_SOURCE=s3://<バケット>/<接頭辞>` と、読むだけの鍵） |

画面は `127.0.0.1:8090` だけで待ち受けます。別のマシンからは SSH のトンネル（`ssh -L 8090:localhost:8090 <サーバー>`）か VPN の内側から開き、`RECOVERY_BIND` に VPN のアドレスを入れます。インターネットには出さないでください。

### 読み取り専用のロール

今の DB への接続は、ツールの側でも読み取り専用にしていますが、DB の側でも書けないロールを使います（`TARGET_DATABASE_URL=postgresql://factoreye_readonly:<パスワード>@postgres:5432/factoreye`）。

```sql
CREATE ROLE factoreye_readonly LOGIN PASSWORD '<openssl rand -hex 24 で作った値>';
-- restore.sh で戻した DB では、ロールはログインできない状態で作られている。そのときは:
-- ALTER ROLE factoreye_readonly LOGIN PASSWORD '<…>';
GRANT CONNECT ON DATABASE factoreye TO factoreye_readonly;
GRANT USAGE ON SCHEMA public TO factoreye_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO factoreye_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE factoreye IN SCHEMA public GRANT SELECT ON TABLES TO factoreye_readonly;
```

## 設定（`.env`）

| 変数 | 既定 | 内容 |
|---|---|---|
| `RECOVERY_PASSWORD` / `RECOVERY_USERNAME` | （必須）/ `admin` | 画面の Basic 認証（12 文字以上） |
| `BACKUP_SOURCE` / `BACKUP_DIR` | `/backups` / `../../backups` | 読み込み元（ディレクトリか `s3://…`）と、`/backups` に見せる手元のディレクトリ |
| `TARGET_DATABASE_URL` | なし | 今の DB（読み取り専用で接続） |
| `TARGET_WRITE_DATABASE_URL` / `TARGET_MODE` | なし | 書き戻しの接続と、今の DB の種類（`saas` / `oss`）。どちらも無ければ閲覧だけ |
| `HANDOFF_SOURCE` | なし | 災害時の控えが置いた増加分の読み込み元（管理画面の「書き戻し」が使う） |
| `WALG_ENV_FILE` / `R2_RESTORE_DIR` | compose では `/etc/recovery/walg/walg.env` / `/var/lib/recovery/r2restore` | 「R2 から復旧する」の設定（`./walg/walg.env`、[`infra/walg/walg.env.example`](../../infra/walg/walg.env.example) と同じ形式。読み取りだけの鍵で足りる）と作業用の領域（本番の DB と同じ大きさの空きが要る） |
| `AWS_ACCESS_KEY_ID` など・`S3_ENDPOINT_URL` | なし | S3 の認証（`s3:ListBucket` と `s3:GetObject` だけの鍵）と、S3 互換のサービス |
| `BACKUP_GID` | `0` | バックアップのファイル（640）のグループ |
| `RECOVERY_BIND` / `RECOVERY_PORT` | `127.0.0.1` / `8090` | 画面の待ち受け |

## 書き換えられたバックアップへの備え

乗っ取られた本番では、バックアップと `.sha256` を一緒に作り直せます。そのため、展開そのものを安全にしています。psql のメタコマンドを止め、管理者ではないロールで流し込み、秘密の環境変数を渡さず、一時的な名前で展開してから名前を変えます。WAL-G の復元では、バックアップの設定ファイル（`postgresql.conf` など）を使わず、最小の自前の設定で起動します。

## 開発

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest && .venv/bin/mypy . && .venv/bin/ruff check .
```

DB を使うテストは `TEST_SCRATCH_DSN`（作業用の PostgreSQL の管理用 DB。例 `postgresql://factoreye:password@localhost:5432/postgres`）と `psql` が要ります。無ければ飛ばします。テストは `bk_*` の DB を作って消すので、本番や開発用の DB は指定しないでください。
