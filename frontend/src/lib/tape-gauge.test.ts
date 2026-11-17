import { describe, expect, it } from "vitest";

import { hourlyTrend, predictedValue, tapeRange, tapeTicks } from "./tape-gauge";

const at = (minutesAgo: number, value: number) => ({ value, recordedAt: new Date(Date.UTC(2026, 10, 18, 1, 0) - minutesAgo * 60_000).toISOString() });

describe("tapeTicks（目盛り）", () => {
  it("両端を必ず入れ、間は範囲の中の切りのよい値", () => {
    const ticks = tapeTicks({ min: 10, max: 34 });
    expect(ticks[0]).toEqual({ value: 10, fraction: 0 });
    expect(ticks[ticks.length - 1]).toEqual({ value: 34, fraction: 1 });
    const middle = ticks.slice(1, -1);
    expect(middle.every((t) => t.value > 10 && t.value < 34 && t.fraction > 0 && t.fraction < 1)).toBe(true);
  });
  it("数字どうしが近すぎない（0〜110 で 100 と 110 が重ならない）", () => {
    const ticks = tapeTicks({ min: 0, max: 110 });
    for (let i = 1; i < ticks.length; i += 1) expect(ticks[i].fraction - ticks[i - 1].fraction).toBeGreaterThanOrEqual(0.15);
  });
});

describe("tapeRange（目盛りの範囲）", () => {
  const limits = { thresholdMinCritical: 16, thresholdMinWarning: 18, thresholdMaxWarning: 26, thresholdMaxCritical: 28 };
  it("しきい値と今の値が収まり、0 から始まらない", () => {
    const range = tapeRange(limits, {}, 22.3);
    expect(range.min).toBeLessThanOrEqual(16);
    expect(range.max).toBeGreaterThanOrEqual(28);
    expect(range.min).toBeGreaterThan(0);
  });
  it("今の値がしきい値の外でも、収まる", () => {
    const range = tapeRange({ ...limits }, {}, 35);
    expect(range.max).toBeGreaterThanOrEqual(35);
  });
  it("しきい値が無ければ、今の値のまわり", () => {
    const none = { thresholdMinCritical: null, thresholdMinWarning: null, thresholdMaxWarning: null, thresholdMaxCritical: null };
    const range = tapeRange(none, {}, 1012.3);
    expect(range.min).toBeLessThan(1012.3);
    expect(range.max).toBeGreaterThan(1012.3);
  });
  it("設定で固定した範囲を使う", () => {
    expect(tapeRange(limits, { gaugeMin: 980, gaugeMax: 1040 }, 22)).toEqual({ min: 980, max: 1040 });
  });
});

describe("hourlyTrend（1 時間あたりの変化）", () => {
  it("新しい順の測定値から、1 時間あたりの変化を求める", () => {
    // 60 分で 20.0 → 21.0（+1.0/h）
    expect(hourlyTrend([at(0, 21), at(30, 20.5), at(60, 20)])).toBeCloseTo(1.0);
  });
  it("間が 20 分未満・1 件だけなら null", () => {
    expect(hourlyTrend([at(0, 21), at(10, 20)])).toBeNull();
    expect(hourlyTrend([at(0, 21)])).toBeNull();
  });
});

describe("predictedValue（15 分後）", () => {
  it("今の傾きが続くとした値", () => {
    expect(predictedValue(21, 1.2)).toBeCloseTo(21.3);
  });
  it("変化が分からなければ null", () => {
    expect(predictedValue(21, null)).toBeNull();
  });
});
