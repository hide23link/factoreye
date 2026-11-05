import { describe, expect, it } from "vitest";

import { nextDashboardName } from "./dashboard-name";

describe("nextDashboardName", () => {
  it("無ければそのまま", () => expect(nextDashboardName(["A"])).toBe("新しいダッシュボード"));
  it("重なれば 2、3 … と進む（空いている最小の番号）", () => {
    expect(nextDashboardName(["新しいダッシュボード"])).toBe("新しいダッシュボード 2");
    expect(nextDashboardName(["新しいダッシュボード", "新しいダッシュボード 2"])).toBe("新しいダッシュボード 3");
    expect(nextDashboardName(["新しいダッシュボード", "新しいダッシュボード 3"])).toBe("新しいダッシュボード 2");
  });
});
