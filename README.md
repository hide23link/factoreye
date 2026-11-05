# FactorEye

予算が限られた中小製造業が、既存の PC と安価なセンサーだけで使える工場監視 OSS です。

- センサー値を REST API で集め、しきい値でアラームを評価し、ダッシュボードに表示する
- 通知は Discord（重故障・軽故障で別チャンネル）、外部連携は Webhook（Zapier / Make / n8n など、コード不要）
- self-hosted が基本（Docker Compose で自社の PC などに展開し、データは社内に残る）
- MIT License

仕様は [`docs/architecture.md`](docs/architecture.md) を参照してください。

---

## クイックスタート

### Ubuntu / Raspberry Pi（1 コマンド）

Ubuntu・Debian・Raspberry Pi OS（64bit）で、次の 1 行を実行します。Docker が無ければ自動で入れます。

```bash
curl -fsSL https://raw.githubusercontent.com/hide23link/factoreye/main/install/install.sh | sudo bash
```

1. **実行する**（数分。ビルドはせず、公開済みのイメージを取得します）
2. **表示された URL をブラウザで開く**（例: `http://192.168.0.20:3001`）。最後に表示される**管理パスワード**は、一度しか出ないので控えてください
3. **画面右上の「セットアップガイド」**に沿って、センサーを登録し、ダッシュボードを作る（約 5 分）

もう一度実行すると、データと設定を残したまま更新します（更新前に自動でバックアップを取ります）。

| やりたいこと | 方法 |
|---|---|
| 設定を変える | 画面の **設定 → API・取り込み**（管理パスワードが必要）。または `/opt/factoreye/config/.env` をテキストで編集し、同じ画面の「ファイルの内容を反映」を押す |
| 管理コマンド | `cd /opt/factoreye && ./factoreye.sh`（`status` / `logs` / `update` / `backup` / `set-password` / `restore-env`） |
| 動作確認 | `cd /opt/factoreye && ./smoke-test.sh http://<IP>:3001 '<管理パスワード>'`（画面・API・認証・設定の保存と再起動を確かめる。パスワードを省くと見るだけ） |
| 削除 | `cd /opt/factoreye && docker compose --env-file config/.env down -v && cd / && sudo rm -rf /opt/factoreye /etc/cron.d/factoreye`（データも消えます） |

**設定ファイル**は `/opt/factoreye/config/.env` の 1 つです。取り込みのキー、認証、自動登録、レート制限などをここに集約しています。秘密の値（`JWT_SECRET`・DB パスワード）は画面に出さず、このファイルでだけ変えます。ひな形は [`install/.env.template`](install/.env.template) です。

> **注意**: 配布版は http です。インターネットから使う場合は、リバースプロキシ（Caddy・Cloudflare Tunnel など）で https にしてください。取り込み先を `INGEST_AUTH=off` にするときは、口を LAN に限定してください。

### Mac / Windows（Docker Desktop）

[Docker Desktop](https://www.docker.com/products/docker-desktop/) を入れて起動してから、ターミナル（Windows は PowerShell か WSL）で実行します。

```bash
mkdir factoreye
cd factoreye
curl -fsSLO https://raw.githubusercontent.com/hide23link/factoreye/main/install/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/hide23link/factoreye/main/install/.env.template
mkdir config
cp .env.template config/.env
```

Windows の PowerShell では、`curl` を `curl.exe` に読み替えてください（`curl` は別のコマンドの別名です）。

`config/.env` を開き、`__GENERATE__` の 4 か所を長いランダムな文字列に置き換えます（`DATABASE_URL` のパスワードと `POSTGRES_PASSWORD` は同じ値）。ランダムな文字列は、Mac は `openssl rand -hex 24`、PowerShell は `-join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })` で作れます。そのあと起動します。

```bash
docker compose --env-file config/.env up -d
```

画面は http://localhost:3001 です。管理パスワード（`ADMIN_PASSWORD_HASH`）は空のままなので、設定は `config/.env` を直接編集して、画面の「ファイルの内容を反映」で取り込みます。


---

### 開発者向け: ソースからビルドして起動する

```bash
docker compose up -d --build
```

- フロントエンド: http://localhost:3001
- バックエンド API: http://localhost:8000（ヘルスチェック: `/health`）
- 初回起動後、画面右上の「セットアップガイド」から、センサー登録からダッシュボード表示まで約 5 分で体験できます

LAN 上の別の端末から使う場合は、リポジトリ直下に `.env` を作り（[`.env.example`](.env.example) を参照）、`VITE_API_URL` と `FRONTEND_URL` をホストの IP アドレスに変更します。

本番で使う前に、`INGEST_API_KEY` を必ず変更してください（`ENVIRONMENT=production` では、既定値のままだと起動しません）。SaaS モード（`AUTH_MODE=multi_tenant`）では、`JWT_SECRET` も変更します。
機器ごとにキーを発行して、そのキーで送る方法（自前ホスト）は [`docs/device-keys.md`](docs/device-keys.md) を参照してください。

機器に API キーを入れたくない運用では、`INGEST_AUTH=off` でキーなしの取り込みにできます。センサーの ingestKey を知っていれば誰でも値を書けるので、取り込みの口を LAN などに限定してください。環境変数の一覧は [`docs/architecture.md`](docs/architecture.md) §11 を参照してください。

---

## 主な機能

- **取り込み**: `POST /api/ingest/readings` でセンサー値を受け取り、1 秒ごとにまとめて保存
- **アラーム**: 上限・下限 × 軽故障・重故障の 4 項目のしきい値、不感帯、確認（ack）
- **通知**: Discord（重故障は通常送信、軽故障はサイレント）、重故障の再通知
- **Webhook**: `reading.received` と `alarm.triggered` のイベントを任意の URL へ送信
- **ダッシュボード**: 12 列グリッドでの自由な配置。グラフ・比較グラフ・最新値・アラーム一覧・生産数の各ウィジェット。グラフの時間範囲は、プリセット・任意の期間・前後への移動・拡大縮小・ドラッグで操作できる
- **データ移行**: 設定画面の「データ移行」から、ワークスペース（SaaS）または全データ（self-hosted）を書き出し、self-hosted へ取り込む
- **SaaS モード**: `AUTH_MODE=multi_tenant`（メール + パスワード、ワークスペース単位の分離、Free Tier、管理者画面 `/admin`）。詳細は [`docs/architecture.md`](docs/architecture.md) §10
- **センサー側のクライアント**: M5 ATOM などの ESP32（ライブラリ `clients/arduino-m5stack/`、設定をスマホの画面だけで済ませるスケッチ [`clients/FactorEyeNode/`](clients/FactorEyeNode/)）、Raspberry Pi（`clients/raspberry-pi/`）
- **テスト用エミュレータ**: `tools/factory-emulator/`（手動操作画面つき）

---

## ディレクトリ構成

```
backend/    REST API・取り込み（Python / FastAPI / SQLModel / PostgreSQL）
frontend/   ダッシュボード UI（React / TypeScript / Vite）
clients/    センサー側のクライアント（ESP32 の Arduino ライブラリ、M5 ATOM 用スケッチ FactorEyeNode、Raspberry Pi）
install/    1 コマンド導入のスクリプトと配布用の docker-compose
tools/      テスト用の工場エミュレータ、バックアップの復旧ツール
e2e/        E2E テスト（Playwright）
loadtest/   負荷テスト用のエミュレータ
infra/      運用スクリプト（バックアップ・復元、クラウド版のサーバー設定）
admin/      SaaS 版の管理者ファイルの例
docs/       仕様書（architecture.md）、機器キーの使い方（device-keys.md）
```

---

## 開発環境

### Backend

```bash
cd backend
pip install -r requirements.txt
# PostgreSQL を別途用意し、接続先を指定する（例は backend/.env.example）
export DATABASE_URL=postgresql+asyncpg://factoreye:password@localhost:5432/factoreye
alembic upgrade head   # テーブルを作る（アプリは起動時に作らない。Docker は起動時に自動で実行する）
uvicorn app.main:app --reload
```

チェック（CI と同じ内容。テスト・型検査・Lint の依存は `requirements-dev.txt`）:

```bash
pip install -r requirements-dev.txt
pytest
mypy .
ruff check .
pip-audit
```

> **注意: テストは専用の DB で実行してください。** backend のテストは、接続先のすべてのテーブルを作り直して削除します。`DATABASE_URL` を開発用・本番用の DB に向けたまま実行すると、データが消えます。
>
> ```bash
> # 例: テスト専用の DB を作って指定する
> createdb factoreye_test
> DATABASE_URL=postgresql+asyncpg://factoreye:password@localhost:5432/factoreye_test pytest
> ```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

```bash
npm run test        # 単体テスト
npm run typecheck   # 型チェック
npm run lint        # lint
```

### E2E

スタックを起動した状態で Playwright を実行します。

```bash
docker compose up -d --build
cd e2e && npm ci && npx playwright install --with-deps chromium && npm test
```

### CI

GitHub Actions（`.github/workflows/`）が、backend・frontend・E2E・各クライアント・導入スクリプトのテストを実行します。

---

## コントリビューション

バグ報告・機能提案・PR を歓迎します。[`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。参加にあたっては [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) に従ってください。

脆弱性を見つけた場合は、公開の Issue ではなく [`SECURITY.md`](SECURITY.md) の手順に従って報告してください。

---

## ライセンス

[MIT License](LICENSE)
