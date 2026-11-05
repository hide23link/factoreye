# 開発環境

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
