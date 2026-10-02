import { expect, test } from "@playwright/test";

import { sendReading } from "./helpers";

// Quick Setup Wizardを実際にブラウザで最初から最後まで通し、センサー登録→データ受信→
// ダッシュボード自動作成→グラフ表示までが壊れていないことを確認する（dev-notes.md記載の
// 手動検証手順をE2Eとして固定化したもの）。
test("セットアップウィザードでセンサー登録からダッシュボード表示まで完了する", async ({
  page,
  request,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "セットアップガイド" }).click();
  await expect(page.getByRole("heading", { name: "1. センサーを登録しましょう" })).toBeVisible();

  const ingestKey = await page.getByLabel("Ingest Key（デバイスが送信時に使う識別子）").inputValue();

  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByRole("heading", { name: "2. テストデータを送ってみましょう" })).toBeVisible();

  await sendReading(request, ingestKey, 42.0);

  await expect(page.getByRole("heading", { name: "3. データを受信しました！" })).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "ダッシュボードを作成" }).click();
  await expect(page.getByRole("heading", { name: "🎉 セットアップ完了！" })).toBeVisible();

  await page.getByRole("button", { name: "ダッシュボードを見る" }).click();
  await expect(page.getByText("はじめてのダッシュボード")).toBeVisible();
  // SensorGraphウィジェットがRechartsのSVGを描画していること
  await expect(page.locator("svg.recharts-surface")).toBeVisible();
});
