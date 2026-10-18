# FactorEye

予算が限られた中小製造業が、既存の PC と安価なセンサーだけで使える工場監視 OSS です。

- センサー値を REST API で集め、しきい値でアラームを評価し、ダッシュボードに表示する
- 通知は Discord（重故障・軽故障で別チャンネル）、外部連携は Webhook（Zapier / Make / n8n など、コード不要）
- self-hosted が基本（Docker Compose で自社の PC などに展開し、データは社内に残る）
- MIT License

仕様は [`docs/architecture.md`](docs/architecture.md)、設計判断は [`docs/decisions.md`](docs/decisions.md)、変更履歴は [`CHANGELOG.md`](CHANGELOG.md) を参照してください。

---

## クイックスタート

```bash
docker compose up -d --build
```

- フロントエンド: http://localhost:3001
- バックエンド API: http://localhost:8000（ヘルスチェック: `/health`）
- 初回起動後、画面右上の「セットアップガイド」から、センサー登録からダッシュボード表示まで約 5 分で体験できます

LAN 上の別の端末から使う場合は、リポジトリ直下に `.env` を作り（[`.env.example`](.env.example) を参照）、`VITE_API_URL` と `FRONTEND_URL` をホストの IP アドレスに変更します。

本番で使う前に、`INGEST_API_KEY` を必ず変更してください（`ENVIRONMENT=production` では、既定値のままだと起動しません）。SaaS モード（`AUTH_MODE=multi_tenant`）では、`JWT_SECRET` も変更します。
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
- **公式クライアント**: Arduino / M5Stack（`clients/arduino-m5stack/`）、Raspberry Pi（`clients/raspberry-pi/`）
- **テスト用エミュレータ**: `tools/factory-emulator/`（手動操作画面つき）
- **復旧ツール**: `tools/recovery/`。バックアップを今の DB と見比べて閲覧・CSV 書き出し・書き戻しをする Web 画面（本体とは独立）

---

## ディレクトリ構成

```
admin/      管理者ファイルの例（SaaS 版。実体は admins.txt で、リポジトリには含めない）
backend/    REST API・取り込み（Python / FastAPI / SQLModel / PostgreSQL）
frontend/   ダッシュボード UI（React / TypeScript / Vite）
e2e/        E2E テスト（Playwright。起動済みのスタックに対して実行）
clients/    センサー向け公式クライアント（Arduino / M5Stack、Raspberry Pi）
tools/      開発補助（テスト用の工場エミュレータ）と、バックアップの復旧ツール（recovery）
loadtest/   負荷テスト用のエミュレータ
infra/      運用スクリプト（DB のバックアップ・復元、クラウド版のサーバー設定）
docs/       仕様書と設計判断の記録
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

docker compose でスタックを起動した状態で実行します。手順は [`e2e/README.md`](e2e/README.md) を参照してください。

```bash
docker compose up -d --build
cd e2e && npm ci && npx playwright install --with-deps chromium && npm test
```

---

## バックアップ

`infra/backup.sh` は PostgreSQL を `pg_dump` で取得します。cron で毎日 3 時に実行し、既定で 7 日分を保持します。手順は [`infra/README.md`](infra/README.md) を参照してください。バックアップの中身の確認・比較・書き戻しは、復旧ツール（[`tools/recovery/README.md`](tools/recovery/README.md)）で行えます。

```bash
./infra/backup.sh            # 手動実行
./infra/restore.sh <file>    # 空の DB へ復元
```

---

## CI

GitHub Actions（`.github/workflows/`）:

| ワークフロー | 内容 |
|---|---|
| `backend-test.yml` | pytest・mypy・ruff・pip-audit |
| `frontend-build.yml` | lint・typecheck・test・build・npm audit |
| `e2e-test.yml` | スタックを起動して Playwright で E2E |
| `arduino-client-compile.yml` | Arduino クライアントのコンパイル確認 |
| `raspberry-pi-client-test.yml` | Raspberry Pi クライアントのテスト |
| `recovery-tool-test.yml` | 復旧ツールのテスト |
| `deploy-cloud.yml` | クラウド版のデプロイ |

---

## コントリビューション

バグ報告・機能提案・PR を歓迎します。[`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。参加にあたっては [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) に従ってください。

脆弱性を見つけた場合は、公開の Issue ではなく [`SECURITY.md`](SECURITY.md) の手順に従って報告してください。

---

## ライセンス

[MIT License](LICENSE)
