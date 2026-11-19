import { expect, test } from "@playwright/test";

import { sendReading } from "./helpers";

// セットアップガイドを実際にブラウザで最初から最後まで通し、センサー登録→データ受信→
// 計器盤（計器と計器グラフ）の自動作成→グラフ表示までが壊れていないことを確認する。
test("セットアップウィザードでセンサー登録からダッシュボード表示まで完了する", async ({
  page,
  request,
}) => {
  await page.goto("/");

  // ダッシュボード0件時はDashboardHomeの案内にも「セットアップガイドを始める」ボタンが
  // 出るため、ヘッダーnav内に絞ってクリックする（部分一致で2件ヒットするのを避ける）
  await page.locator("nav").getByRole("button", { name: "セットアップガイド" }).click();
  await expect(page.getByRole("heading", { name: "最初のグラフを出すまで" })).toBeVisible();
  await expect(page.getByText("0 / 4 完了")).toBeVisible();

  const ingestKey = await page.getByLabel("Ingest Key（デバイスが送信時に使う識別子）").inputValue();

  await page.getByRole("button", { name: "次へ" }).click();
  // 段階 2: テストデータを送る（コードの例と、受信待ちの表が出る）
  await expect(page.getByText("1 / 4 完了")).toBeVisible();
  await expect(page.getByText(/下のコードをパソコンで 1 回実行/)).toBeVisible();

  await sendReading(request, ingestKey, 42.0);

  // 3 秒ごとの確認で、値が届くと自動で段階 3 へ進む
  await expect(page.getByText("2 / 4 完了")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "計器盤を作る" }).click();
  await expect(page.getByText("4 / 4 完了")).toBeVisible();

  await page.getByRole("button", { name: "ダッシュボードを見る" }).click();
  await expect(page.getByText("はじめてのダッシュボード").first()).toBeVisible();
  // 計器グラフ（TrendStack）が、センサーの推移を描画していること
  await expect(page.getByRole("img", { name: /の推移/ })).toBeVisible();
});
