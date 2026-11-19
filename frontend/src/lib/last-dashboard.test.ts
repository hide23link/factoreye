import { afterEach, describe, expect, it, vi } from "vitest";

import { pickDashboardId, readLastDashboardId, writeLastDashboardId } from "./last-dashboard";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("pickDashboardId（開くダッシュボードを決める）", () => {
  it("最後に見たものが今もあればそれを選ぶ", () => expect(pickDashboardId(["a", "b"], "b")).toBe("b"));
  it("最後に見たものが消えていれば、先頭", () => expect(pickDashboardId(["a", "b"], "x")).toBe("a"));
  it("覚えていなければ、先頭", () => expect(pickDashboardId(["a", "b"], null)).toBe("a"));
  it("1 つも無ければ null", () => expect(pickDashboardId([], "a")).toBeNull());
});

describe("最後に見たダッシュボードの記録", () => {
  it("書いた ID を読める。null を書くと忘れる", () => {
    writeLastDashboardId("d1");
    expect(readLastDashboardId()).toBe("d1");
    writeLastDashboardId(null);
    expect(readLastDashboardId()).toBeNull();
  });

  it("localStorage が使えなくても、例外にしない", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readLastDashboardId()).toBeNull();
    expect(() => writeLastDashboardId("d1")).not.toThrow();
  });
});
