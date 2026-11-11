import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// 主要画面をaxe-coreで検査する（WCAG 2.1 A/AA）。
// 現状は既知の違反が残っているため、「致命的（critical）な違反が無い」ことだけを必須にする。
// 重大度が serious 以下の違反は、テスト結果の添付ファイル（a11y-*.json）に残す。
// 違反を直したら、下の BLOCKING_IMPACTS に "serious" を足して厳しくしていく。
const BLOCKING_IMPACTS = ["critical"];

const pages = [
  { name: "ダッシュボード一覧", open: async () => {} },
  {
    name: "設定",
    open: async (page: import("@playwright/test").Page) => {
      await page.getByRole("button", { name: "設定" }).click();
      await expect(page.getByRole("button", { name: "追加" })).toBeVisible();
    },
  },
  {
    name: "アラーム",
    // アラームは設定画面の中のタブ
    open: async (page: import("@playwright/test").Page) => {
      await page.getByRole("button", { name: "設定" }).click();
      await page.getByRole("button", { name: "アラーム" }).click();
    },
  },
];

for (const target of pages) {
  test(`アクセシビリティ: ${target.name}に致命的な違反が無い`, async ({ page }, testInfo) => {
    await page.goto("/");
    await target.open(page);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    await testInfo.attach(`a11y-${target.name}.json`, {
      body: JSON.stringify(
        results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.length,
        })),
        null,
        2,
      ),
      contentType: "application/json",
    });

    const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.includes(v.impact ?? ""));
    expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}
