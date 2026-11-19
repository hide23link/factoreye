import { expect, test } from "@playwright/test";

import { sendReading } from "./helpers";

// 設定画面でセンサーの閾値を設定 → 閾値超過データを送信 → アラームが発生し確認(ack)できる、
// という一連の流れを確認する。
test("閾値超過でアラームが発生し、設定画面から確認できる", async ({ page, request }) => {
  const sensorName = `E2Eセンサー-${Date.now()}`;
  const ingestKey = `e2e-${Date.now()}`;

  await page.goto("/");
  await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("button", { name: "設定" }).click();

  // 追加のフォームは「＋センサーを追加」で開く（センサーが 0 件のときは最初から開いている）
  await page.getByRole("button", { name: "＋センサーを追加" }).click();
  await page.getByLabel("名前").fill(sensorName);
  await page.getByLabel("Ingest Key").fill(ingestKey);
  await page.getByRole("button", { name: "追加", exact: true }).click();

  // 一覧は一度に 50 件まで。ほかのテストで増えたセンサーに埋もれないよう、名前で絞り込む
  await page.getByRole("searchbox", { name: "センサーを絞り込む" }).fill(sensorName);
  const row = page.locator("tr", { hasText: sensorName });
  await expect(row).toBeVisible();

  // 名前を押すと右に詳細の欄が開く。重故障の上限を設定して保存する
  await row.getByRole("button", { name: `${sensorName} の詳細` }).click();
  const detail = page.getByRole("complementary", { name: `${sensorName} の詳細` });
  await detail.getByRole("spinbutton", { name: "重故障の上限" }).fill("50");
  await detail.getByRole("button", { name: "保存" }).click();
  // 一覧の「しきい値」の列は、上限だけのとき「≤ 50」と出る
  await expect(row).toContainText("≤ 50");

  await sendReading(request, ingestKey, 55);

  await page.getByRole("button", { name: "アラーム" }).click();
  const alarmRow = page.locator("tr", { hasText: sensorName });
  await expect(alarmRow).toBeVisible({ timeout: 15_000 });
  await expect(alarmRow.getByText("上限超過")).toBeVisible();
  // 重故障のしきい値を超えたので重故障（通常通知）として扱われることを確認
  await expect(alarmRow.getByText("🚨 重故障")).toBeVisible();

  await alarmRow.getByRole("button", { name: "確認" }).click();
  // 「確認済み」ボタンは常時表示のステータスタブと名前が衝突するため、
  // ackが実際に効いたことは「発生中」一覧からこの行が消えることで検証する
  await expect(page.locator("tr", { hasText: sensorName })).toHaveCount(0);

  await page.getByRole("button", { name: "確認済み" }).click();
  const ackedRow = page.locator("tr", { hasText: sensorName });
  await expect(ackedRow).toBeVisible();
  await expect(ackedRow.getByText("確認済み")).toBeVisible();
});
