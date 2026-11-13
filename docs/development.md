# 開発環境

ソースからまとめて起動する: `docker compose up -d --build`（画面 http://localhost:3001、API http://localhost:8000）。本番で使う前に `INGEST_API_KEY` を必ず変更してください。

## Backend

```bash
cd backend
pip install -r requirements.txt
# PostgreSQL を別途用意し、接続先を指定する（例は backend/.env.example）
export DATABASE_URL=postgresql+asyncpg://factoreye:password@localhost:5432/factoreye
alembic upgrade head   # テーブルを作る（アプリは起動時に作らない。Docker は起動時に自動で実行する）
uvicorn app.main:app --reload
```

チェック（CI と同じ内容）:

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

## Frontend

```bash
cd frontend
npm install
npm run dev
```

```bash
npm run test        # 単体テスト
npm run typecheck   # 型チェック
npm run lint        # lint（アクセシビリティの警告 jsx-a11y も含む。既存の違反を直したら error に戻す）
npm run test:coverage  # カバレッジ（stmt/line 80%・branch/func 75% を下回ると失敗）
```

## E2E

スタックを起動した状態で Playwright を実行します。

```bash
docker compose up -d --build
cd e2e && npm ci && npx playwright install --with-deps chromium && npm test
```

E2E は chromium が必須で、firefox・webkit・スマホ画面（mobile-chrome）は互換性の確認用です（失敗してもマージは止まりません）。ブラウザを指定して実行するには `npx playwright test --project=firefox` のようにします。`tests/a11y.spec.ts` は axe-core で主要画面を検査し、致命的（critical）な違反があると失敗します。
