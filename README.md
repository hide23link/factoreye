# FactorEye

予算が限られた中小製造業が、既存の PC と安価なセンサーだけで使える工場監視 OSS です。

- センサー値を REST API で集め、しきい値でアラームを評価し、ダッシュボードに表示する
- 通知は Discord（重故障・軽故障で別チャンネル）、外部連携は Webhook（Zapier / Make / n8n など、コード不要）
- self-hosted が基本（Docker Compose で社内の PC などに展開し、データは社内に残る）
- MIT License

| ドキュメント | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 仕様（API・取り込み・アラーム・環境変数・既知の制限） |
| [`docs/decisions.md`](docs/decisions.md) | 設計判断と理由 |
| [`docs/code-tour.md`](docs/code-tour.md) | コードの構成とデータの流れ（読み始めの地図） |
| [`CHANGELOG.md`](CHANGELOG.md) | 変更履歴 |
| [`infra/README.md`](infra/README.md) | バックアップ・復元、本番の外への控え（運用者向け） |
| [`tools/recovery/README.md`](tools/recovery/README.md) | 復旧ツール（バックアップの確認と書き戻し） |

---

## クイックスタート

```bash
docker compose up -d --build
```

- フロントエンド: http://localhost:3001
- バックエンド API: http://localhost:8000（ヘルスチェック: `/health`）
- 初回起動後、画面右上の「セットアップガイド」から、約 5 分でセンサー登録からダッシュボード表示まで体験できます

**LAN 上の別の端末から使う場合**: リポジトリ直下に `.env` を作り（[`.env.example`](.env.example) を参照）、`VITE_API_URL` と `FRONTEND_URL` をホストの IP アドレスにします。

**本番で使う前に**: `INGEST_API_KEY` を必ず変更してください（`ENVIRONMENT=production` では、既定値のままだと起動しません）。SaaS モード（`AUTH_MODE=multi_tenant`）では `JWT_SECRET` も変更します。機器に API キーを入れたくない場合は `INGEST_AUTH=off` を使えますが、`ingestKey` を知っていれば誰でも値を書けるので、取り込みの口を LAN などに限定してください。環境変数の一覧は [`docs/architecture.md`](docs/architecture.md) §11 にあります。

---

## 主な機能

- **取り込み**: `POST /api/ingest/readings` で受け取り、1 秒ごとにまとめて保存
- **アラーム**: 上限・下限 × 軽故障・重故障の 4 項目のしきい値、不感帯、確認（ack）
- **通知**: Discord（重故障は通常送信、軽故障はサイレント、重故障の再通知）、Webhook（`reading.received`・`alarm.triggered`）
- **ダッシュボード**: 12 列グリッドでの自由な配置。グラフ・比較グラフ・最新値・ゲージ・アラーム一覧・稼働状況・生産管理。グラフの時間範囲は、プリセット・任意の期間・前後への移動・拡大縮小・ドラッグで操作
- **データ移行**: 設定画面の「データ移行」から、ワークスペース（SaaS）または全データ（self-hosted）を書き出し、self-hosted へ取り込む
- **SaaS モード**: `AUTH_MODE=multi_tenant`（メール + パスワード、ワークスペース単位の分離、Free Tier、管理者画面 `/admin`）
- **公式クライアント**: Arduino / M5Stack（`clients/arduino-m5stack/`）、Raspberry Pi（`clients/raspberry-pi/`）
- **テスト用エミュレータ**: 工場の疑似データ（`tools/factory-emulator/`）、負荷テスト（`loadtest/`）
- **復旧ツール**: バックアップを今の DB と見比べて閲覧・CSV 書き出し・書き戻しをする（`tools/recovery/`。本体とは独立）

---

## 開発環境

### Backend

```bash
cd backend
pip install -r requirements-dev.txt
# PostgreSQL を別途用意し、接続先を指定する（例は backend/.env.example）
export DATABASE_URL=postgresql+asyncpg://factoreye:password@localhost:5432/factoreye
alembic upgrade head   # テーブルを作る（Docker は起動時に自動で実行する）
uvicorn app.main:app --reload
```

チェック（CI と同じ内容）:

```bash
pytest && mypy . && ruff check . && pip-audit
```

> **注意: テストは専用の DB で実行してください。** backend のテストは、接続先のすべてのテーブルを作り直して削除します。開発用・本番用の DB に向けたまま実行すると、データが消えます。
>
> ```bash
> createdb factoreye_test
> DATABASE_URL=postgresql+asyncpg://factoreye:password@localhost:5432/factoreye_test pytest
> ```

### Frontend

```bash
cd frontend
npm install
npm run dev         # 開発サーバー
npm run test        # 単体テスト
npm run typecheck   # 型チェック
npm run lint        # lint
```

### E2E

docker compose でスタックを起動した状態で実行します。手順は [`e2e/README.md`](e2e/README.md) を参照してください。

---

## バックアップ

`infra/backup.sh` が DB を毎日取得し（cron で 3 時）、既定で 7 日分を保持します。復元は `infra/restore.sh`（空の DB へ）。手順と運用の全体は [`infra/README.md`](infra/README.md)、中身の確認と書き戻しは [`tools/recovery/README.md`](tools/recovery/README.md) を参照してください。

---

## CI

GitHub Actions（`.github/workflows/`）:

| ワークフロー | 内容 |
|---|---|
| `backend-test.yml` | pytest・mypy・ruff・pip-audit |
| `frontend-build.yml` | lint・typecheck・test・build・npm audit |
| `e2e-test.yml` | スタックを起動して Playwright で E2E |
| `arduino-client-compile.yml` / `raspberry-pi-client-test.yml` | 機器クライアントのコンパイル・テスト |
| `recovery-tool-test.yml` | 復旧ツールのテスト |
| `deploy-cloud.yml` | クラウド版のデプロイ |

---

## コントリビューション

バグ報告・機能提案・PR を歓迎します。[`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。参加にあたっては [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) に従ってください。脆弱性を見つけた場合は、公開の Issue ではなく [`SECURITY.md`](SECURITY.md) の手順で報告してください。

---

## ライセンス

[MIT License](LICENSE)
