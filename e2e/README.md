# E2E テスト

Playwright で、実際のブラウザから docker compose 上の backend・frontend を通して操作し、画面の流れ（セットアップガイド・アラームの発生と確認・データ移行・アクセシビリティ）を確かめます。

## 実行

```bash
# 1. リポジトリ直下でスタックを起動する（初回はビルドで数分かかる）
docker compose up -d --build

# 2. backend が応答するまで待つ（移行の途中は接続が切られることがある。数回試す）
curl --retry 10 --retry-delay 2 --retry-connrefused http://localhost:8000/health

# 3. テストを実行する
cd e2e
npm ci
npx playwright install --with-deps chromium
npm test                                # 全プロジェクト（chromium・firefox・webkit・mobile-chrome）
npx playwright test --project=chromium  # chromium だけ

# 4. 後片付け
cd .. && docker compose down
```

- 接続先の既定は `http://localhost:3001`。別のポートで動かしているときは `E2E_BASE_URL` で変える
- CI で必須なのは chromium だけ（ほかは互換性の確認用。`.github/workflows/e2e-test.yml`）

## 注意

- テストは、docker compose の**開発用の DB** にセンサー・ダッシュボードを実際に作る。本番や共有の環境に向けて実行しない
- センサー名・取り込みキーは実行ごとに変えるので、何度実行してもぶつからない
- `.env` で `INGEST_API_KEY` を既定値から変えているときは、同じ値を環境変数 `INGEST_API_KEY` で渡す
