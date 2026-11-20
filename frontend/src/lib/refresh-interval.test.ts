import { describe, expect, it } from "vitest";

import {
  availableRefreshChoices,
  isWidgetQueryKey,
  formatUpdatedAt,
  latestUpdatedAt,
  resolveRefetchMs,
  sanitizeRefreshChoice,
} from "./refresh-interval";

describe("resolveRefetchMs", () => {
  it("各グラフの設定に従うときは、グラフ側の間隔のまま", () => {
    expect(resolveRefetchMs("graph", 30000)).toBe(30000);
    expect(resolveRefetchMs("graph", 60000)).toBe(60000);
  });
  it("Off は自動で取り直さない", () => {
    expect(resolveRefetchMs("off", 30000)).toBe(false);
  });
  it("秒数を選ぶと、グラフ側の間隔を上書きする", () => {
    expect(resolveRefetchMs("10", 60000)).toBe(10000);
    expect(resolveRefetchMs("300", 10000)).toBe(300000);
  });
});

describe("選択肢", () => {
  it("OSS は 10 秒を出し、SaaS は出さない", () => {
    expect(availableRefreshChoices(false).map((c) => c.value)).toContain("10");
    expect(availableRefreshChoices(true).map((c) => c.value)).not.toContain("10");
  });
  it("保存値が不正・SaaS での 10 秒は既定に戻す", () => {
    expect(sanitizeRefreshChoice("60", false)).toBe("60");
    expect(sanitizeRefreshChoice("10", false)).toBe("10");
    expect(sanitizeRefreshChoice("10", true)).toBe("graph");
    expect(sanitizeRefreshChoice("abc", false)).toBe("graph");
    expect(sanitizeRefreshChoice(null, false)).toBe("graph");
  });
});

describe("最終更新", () => {
  it("いちばん新しい更新時刻を返す。未取得（0）は無視し、無ければ null", () => {
    expect(latestUpdatedAt([{ dataUpdatedAt: 0 }, { dataUpdatedAt: 5 }, { dataUpdatedAt: 3 }])).toBe(5);
    expect(latestUpdatedAt([{ dataUpdatedAt: 0 }])).toBeNull();
    expect(latestUpdatedAt([])).toBeNull();
  });
  it("時刻を HH:mm:ss にする", () => {
    expect(formatUpdatedAt(new Date(2024, 0, 1, 7, 5, 9).getTime())).toBe("07:05:09");
  });
});

describe("isWidgetQueryKey", () => {
  it("測定値の取得だけが対象で、センサー一覧・警報などは対象外", () => {
    expect(isWidgetQueryKey(["readings-downsampled", "s1", 1, 2, 500])).toBe(true);
    expect(isWidgetQueryKey(["readings", "s1", 1, 1])).toBe(true);
    expect(isWidgetQueryKey(["readings-aggregate", "s1", "a"])).toBe(true);
    expect(isWidgetQueryKey(["sensors"])).toBe(false);
    expect(isWidgetQueryKey(["alarms"])).toBe(false);
    expect(isWidgetQueryKey(["latest-readings"])).toBe(false);
    expect(isWidgetQueryKey([])).toBe(false);
  });
});
