# E2E テスト

Playwrightで、実際のブラウザ（Chromium）からdocker-compose上のbackend/frontendを
一気通貫で操作して検証する。frontendの単体テスト（`frontend/`配下、Vitest）では
確認できない「実際の画面遷移・API連携・Recharts描画」をカバーする。

## 前提

- Docker / Docker Composeが使えること
- リポジトリ直下で一度もdocker-composeを起動していない場合、ポート3001(frontend)・
  8000(backend)・5432(postgres)が空いていること

## 実行方法

```bash
# 1. リポジトリ直下でスタックを起動（初回はビルドが走るため数分かかる）
docker compose up -d --build

# 2. backend/frontendが応答するまで待つ（docker compose psで状態確認可）
curl --retry 10 --retry-delay 2 --retry-connrefused http://localhost:8000/health

# 3. E2Eテストを実行
cd e2e
npm ci
npx playwright install --with-deps chromium
npm test

# 4. 終わったらスタックを停止
cd ..
docker compose down
```

## 注意点

- テストは`docker compose`の**開発用DB**に対してセンサー・ダッシュボードを実際に作成する
  （本番/共有環境に向けて実行しないこと）。
- センサー名・Ingest Keyは実行の度にユニーク化しているため、複数回実行しても衝突しない。
- `INGEST_API_KEY`を`.env`でデフォルト（`change-this-in-production`）から変更している場合は、
  同じ値を環境変数`INGEST_API_KEY`としてテスト実行時にも渡すこと。
