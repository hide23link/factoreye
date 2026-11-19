import { describe, expect, it } from "vitest";

import { compareAvailability, compareName, compareOffsetMs, describeCompare, parseCompareMode, shiftPointsForward, shiftRange } from "./compare-range";

const DAY = 86_400_000;
const format = (value: number) => value.toFixed(1);

describe("compare-range（昨日の重ね）", () => {
  it("ずらす長さは、昨日＝24 時間、先週＝7 日、なし＝0", () => {
    expect([compareOffsetMs("none"), compareOffsetMs("yesterday"), compareOffsetMs("week")]).toEqual([0, DAY, 7 * DAY]);
    expect([compareName("yesterday"), compareName("week"), compareName("none")]).toEqual(["昨日", "先週", ""]);
  });

  it("保存してあった値が壊れていたら、なしにする", () => {
    expect(parseCompareMode("yesterday")).toBe("yesterday");
    expect(parseCompareMode("month")).toBe("none");
    expect(parseCompareMode(undefined)).toBe("none");
  });

  it("範囲を前にずらし、比較の点は今の時刻の位置へ進める（固定の期間でも 1 日前が重なる）", () => {
    expect(shiftRange({ from: 3 * DAY, to: 4 * DAY }, "yesterday")).toEqual({ from: 2 * DAY, to: 3 * DAY });
    expect(shiftPointsForward([{ time: 2 * DAY + 5, value: 1 }], "yesterday")).toEqual([{ time: 3 * DAY + 5, value: 1 }]);
  });

  it("OSS（保持期間の制限なし）は、いつでも選べる", () => {
    expect(compareAvailability("week", 0, 100 * DAY, Infinity)).toEqual({ ok: true, reason: null });
  });

  it("SaaS（14 日）は、ずらした始めが保持期間の外なら選べず、理由を返す。なしは常に選べる", () => {
    const now = 100 * DAY;
    expect(compareAvailability("yesterday", now - 24 * 3_600_000, now, 14 * DAY).ok).toBe(true);
    expect(compareAvailability("week", now - 8 * DAY, now, 14 * DAY)).toEqual({
      ok: false,
      reason: "先週の同じ時間帯が、データの保持期間（14 日）の外になるため選べません",
    });
    expect(compareAvailability("none", 0, now, 14 * DAY).ok).toBe(true);
  });

  it("ちょうど 14 日前までは選べる（数十秒のずれは許す）", () => {
    const now = 100 * DAY;
    expect(compareAvailability("week", now - 7 * DAY + 30_000, now, 14 * DAY).ok).toBe(true);
  });

  it("値の一覧の文字は「昨日 62.4（差 +4.1）」。差は 今 − 比較", () => {
    expect(describeCompare("yesterday", 62.4, 66.5, format)).toBe("昨日 62.4（差 +4.1）");
    expect(describeCompare("week", 62.4, 60, format)).toBe("先週 62.4（差 -2.4）");
  });

  it("差が丸めて 0 なら符号なし。今の値が無ければ差を出さない", () => {
    expect(describeCompare("yesterday", 62.4, 62.41, format)).toBe("昨日 62.4（差 0.0）");
    expect(describeCompare("yesterday", 62.4, null, format)).toBe("昨日 62.4");
  });
});
