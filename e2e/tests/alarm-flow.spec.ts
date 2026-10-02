import { expect, test } from "@playwright/test";

import { sendReading } from "./helpers";

// 設定画面でセンサーの閾値を設定 → 閾値超過データを送信 → アラームが発生し確認(ack)できる、
// という一連の流れを確認する（dev-notes.md 2026-10-02のSprint 6後半 手動検証を固定化）。
test("閾値超過でアラームが発生し、設定画面から確認できる", async ({ page, request }) => {
  const sensorName = `E2Eセンサー-${Date.now()}`;
  const ingestKey = `e2e-${Date.now()}`;

  await page.goto("/");
  await page.getByRole("button", { name: "設定" }).click();

  await page.getByLabel("名前").fill(sensorName);
  await page.getByLabel("Ingest Key").fill(ingestKey);
  await page.getByRole("button", { name: "追加" }).click();

  // ingestKey列は編集モードでも常にプレーンテキストのtdのまま
  // （name列は編集モードでinputに置き換わりhasTextで拾えなくなるため、ここでは使わない）
  const row = page.locator("tr", { hasText: ingestKey });
  await expect(row).toBeVisible();

  await row.getByText("編集").click();
  await row.locator('input[placeholder="なし"]').nth(1).fill("50");
  await row.getByRole("button", { name: "保存" }).click();
  // td順: 名前/IngestKey/単位/下限/上限/状態/操作
  await expect(row.locator("td").nth(4)).toHaveText("50");

  await sendReading(request, ingestKey, 55);

  await page.getByRole("button", { name: "アラーム" }).click();
  const alarmRow = page.locator("tr", { hasText: sensorName });
  await expect(alarmRow).toBeVisible({ timeout: 15_000 });
  await expect(alarmRow.getByText("上限超過")).toBeVisible();

  await alarmRow.getByRole("button", { name: "確認" }).click();
  // 「確認済み」ボタンは常時表示のステータスタブと名前が衝突するため、
  // ackが実際に効いたことは「発生中」一覧からこの行が消えることで検証する
  await expect(page.locator("tr", { hasText: sensorName })).toHaveCount(0);

  await page.getByRole("button", { name: "確認済み" }).click();
  const ackedRow = page.locator("tr", { hasText: sensorName });
  await expect(ackedRow).toBeVisible();
  await expect(ackedRow.getByText("確認済み")).toBeVisible();
});
