import { defineConfig, devices } from "@playwright/test";

// docker-compose（backend:8000 / frontend:3001）が起動済みであることを前提とする。
// 起動方法はe2e/README.md参照。webServerで自動起動しないのは、postgresのヘルスチェック
// 待ちを含むdocker composeの起動をPlaywrightのwebServer機構に委ねるより、
// CI/ローカルで同じ`docker compose up`手順を明示的に踏む方がシンプルなため。
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3001",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
