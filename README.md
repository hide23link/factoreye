# FactorEye

予算が限られた中小製造業が、既存PCと安価なセンサーだけで使える工場監視OSS。

- センサー値を集めて（REST Ingest API）、閾値監視・アラーム評価を行い、ダッシュボードで可視化する
- self-hosted前提（Docker Composeで自社PC/Proxmoxに展開、データは社内に残る）
- プラグインシステムで業種別にカスタマイズ可能
- MIT License

詳細な設計は（別リポジトリの）コマンドセンターの `docs/factoreye-architecture.md` を参照。本リポジトリ内の運用メモは [`docs/dev-notes.md`](docs/dev-notes.md)。

## クイックスタート（Docker Compose）

```bash
docker compose up -d --build
```

- フロントエンド: http://localhost:3001
- バックエンドAPI: http://localhost:8000 （ヘルスチェック: `/health`）
- 初回起動後、画面右上ナビの「セットアップガイド」から5分でセンサー登録〜ダッシュボード表示まで体験できる

LAN上の別ホスト（Raspberry Pi等）で動かす場合は、リポジトリ直下に `.env` を作成し
[`.env.example`](.env.example) を参考に `VITE_API_URL` / `FRONTEND_URL` をそのホストの実IPに変更する。

## ディレクトリ構成

```
backend/    REST ingest API + REST API（Python / FastAPI / SQLModel / PostgreSQL）
frontend/   ダッシュボードUI（React / TypeScript / Vite）
e2e/        E2Eテスト（Playwright、docker-compose起動済みスタックに対して実行）
clients/    センサーデバイス向け公式クライアント（Arduino/M5Stack・Raspberry Pi）
tools/      開発補助ツール（テスト用工場エミュレータ等）
docs/       開発ノート・運用メモ
```

## 開発環境セットアップ

### Backend

```bash
cd backend
pip install -r requirements.txt
# DATABASE_URL等は.envまたは環境変数で指定（app/config.py参照）
uvicorn app.main:app --reload
```

```bash
# テスト・型チェック・lint・依存脆弱性チェック
pytest
mypy .
ruff check .
pip-audit
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

```bash
# 単体テスト・型チェック・lint
npm run test
npm run typecheck
npm run lint
```

### E2E

docker-composeでスタックを起動した状態で実行する。手順は [`e2e/README.md`](e2e/README.md) を参照。

```bash
docker compose up -d --build
cd e2e && npm ci && npx playwright install --with-deps chromium && npm test
```

## CI

GitHub Actionsで以下を自動実行（`.github/workflows/`）:

- `backend-test.yml`: pytest / mypy / ruff / pip-audit
- `frontend-build.yml`: lint / typecheck / test / build / npm audit
- `e2e-test.yml`: docker-compose起動 → Playwright E2E
- `arduino-client-compile.yml` / `raspberry-pi-client-test.yml`: 各クライアントライブラリの検証

## ライセンス

[MIT License](LICENSE)
