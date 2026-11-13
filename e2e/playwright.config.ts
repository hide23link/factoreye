import { defineConfig, devices } from "@playwright/test";

// docker-compose（backend:8000 / frontend:3001）が起動済みであることを前提とする。
// 起動方法はe2e/README.md参照。webServerで自動起動しないのは、postgresのヘルスチェック
// 待ちを含むdocker composeの起動をPlaywrightのwebServer機構に委ねるより、
// CI/ローカルで同じ`docker compose up`手順を明示的に踏む方がシンプルなため。
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  // CI では GitHub の注釈に加え、HTML レポート（playwright-report/）も作る。
  // 失敗時のトレースは test-results/ に残る（workflow がどちらもアップロードする）
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: "http://localhost:3001",
    trace: "retain-on-failure",
  },
  // chromium は必須（CI で失敗するとマージ不可）。それ以外は互換性の確認用で、CI では失敗しても
  // マージを止めない（.github/workflows/e2e-test.yml の matrix 参照）。
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    // スマホ縦画面（タブレット・現場の携帯端末を想定）
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
});
