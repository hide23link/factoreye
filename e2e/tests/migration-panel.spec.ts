import { expect, test } from "@playwright/test";
import { gzipSync } from "node:zlib";

// 設定画面の「データ移行」パネルを、実際のブラウザから操作する。
// 取り込みは「内容を確認（dry-run）」まで。最後に確定すると開発用DBにセンサーが入るため、ここでは行わない
// （確定の経路は backend のテスト（test_migration_api.py）と CLI の実行で確認済み）。
test("データ移行: 書き出しファイルの件数を確認できる（取り込みは確定しない）", async ({ page }) => {
  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("button", { name: "データ移行" }).click();

  // self-hosted（ログイン無し）では、書き出し（全データのバックアップ用）と取り込みの両方が出る
  await expect(page.getByRole("heading", { name: "取り込み（OSS へ移す）" })).toBeVisible();
  await expect(page.getByRole("button", { name: "書き出す" })).toBeVisible();

  // 書き出しファイル（gzip の JSON Lines）を、書き出し形式どおりに組み立てる
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const sensorId = "00000000-0000-4000-8000-000000000002";
  const now = new Date().toISOString();
  const lines = [
    {
      format: "factoreye-workspace-export",
      version: 2,
      workspace_id: workspaceId,
      exported_at: now,
      alembic_version: "h8c9d0e1f2a3",
    },
    {
      t: "sensors",
      r: {
        id: sensorId,
        workspace_id: workspaceId,
        name: "移行テスト用センサー",
        ingest_key: `e2e-migrate-${Date.now()}`,
        unit: "℃",
        threshold_min_warning: null,
        threshold_min_critical: null,
        threshold_max_warning: null,
        threshold_max_critical: null,
        threshold_dead_band: 0,
        enabled: true,
        created_at: now,
        updated_at: now,
      },
    },
  ];
  const body = gzipSync(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

  await page.getByLabel("取り込むファイル").setInputFiles({
    name: "workspace.jsonl.gz",
    mimeType: "application/gzip",
    buffer: body,
  });
  await page.getByRole("button", { name: "内容を確認" }).click();

  await expect(page.getByText("取り込める件数")).toBeVisible();
  await expect(page.getByText("センサー: 1 件")).toBeVisible();
  await expect(page.getByRole("button", { name: "この内容で取り込む" })).toBeVisible();
});
