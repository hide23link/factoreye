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

本番で使う前に、`INGEST_API_KEY` と `JWT_SECRET` を必ず変更してください。

---

## 主な機能

- **取り込み**: `POST /api/ingest/readings` でセンサー値を受け取り、1 秒ごとにまとめて保存
- **アラーム**: 上限・下限 × 軽故障・重故障の 4 項目のしきい値、不感帯、確認（ack）
- **通知**: Discord（重故障は通常送信、軽故障はサイレント）、重故障の再通知
- **Webhook**: `reading.received` と `alarm.triggered` のイベントを任意の URL へ送信
- **ダッシュボード**: 12 列グリッドでの自由な配置。グラフ・比較グラフ・最新値・アラーム一覧・生産数の各ウィジェット
- **公式クライアント**: Arduino / M5Stack（`clients/arduino-m5stack/`）、Raspberry Pi（`clients/raspberry-pi/`）
- **テスト用エミュレータ**: `tools/factory-emulator/`（手動操作画面つき）

---

## ディレクトリ構成

```
backend/    REST API・取り込み（Python / FastAPI / SQLModel / PostgreSQL）
frontend/   ダッシュボード UI（React / TypeScript / Vite）
e2e/        E2E テスト（Playwright。起動済みのスタックに対して実行）
clients/    センサー向け公式クライアント（Arduino / M5Stack、Raspberry Pi）
tools/      開発補助（テスト用の工場エミュレータ）
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
uvicorn app.main:app --reload
```

チェック（CI と同じ内容。テスト・型検査・Lint の依存は `requirements-dev.txt`）:

```bash
pip install -r requirements-dev.txt
pytest
mypy app
ruff check app tests
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

`infra/backup.sh` は PostgreSQL を `pg_dump` で取得します。cron で毎日 3 時に実行し、既定で 7 日分を保持します。手順は [`infra/README.md`](infra/README.md) を参照してください。

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
| `deploy-cloud.yml` | クラウド版のデプロイ |

---

## コントリビューション

バグ報告・機能提案・PR を歓迎します。[`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。参加にあたっては [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) に従ってください。

脆弱性を見つけた場合は、公開の Issue ではなく [`SECURITY.md`](SECURITY.md) の手順に従って報告してください。

---

## ライセンス

[MIT License](LICENSE)
