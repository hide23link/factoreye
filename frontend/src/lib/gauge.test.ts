import { describe, expect, it } from "vitest";

import { gaugeArcPath, gaugeFraction, gaugePointAt, gaugeRange, gaugeZones } from "./gauge";

const none = { thresholdMaxWarning: null, thresholdMaxCritical: null, thresholdMinWarning: null, thresholdMinCritical: null };

describe("gaugeRange", () => {
  it("手動（最小・最大の両方）があればそれを使う", () => {
    expect(gaugeRange(none, { gaugeMin: 10, gaugeMax: 50 }, 30)).toEqual({ min: 10, max: 50 });
  });

  it("片方だけ、または 最小 >= 最大 の手動は使わず、自動にする", () => {
    expect(gaugeRange(none, { gaugeMin: 10 }, 30).min).toBe(0);
    expect(gaugeRange(none, { gaugeMin: 50, gaugeMax: 10 }, 30)).toEqual({ min: 0, max: 50 });
  });

  it("しきい値が 0 以上なら、0 から、最大のしきい値の少し先まで", () => {
    // 80・90: 幅 10、余白は max(幅, 90 の 25% = 22.5, 1) = 22.5
    expect(gaugeRange({ ...none, thresholdMaxWarning: 80, thresholdMaxCritical: 90 }, {}, 70)).toEqual({ min: 0, max: 112.5 });
  });

  it("下限のしきい値が負なら、その下まで広げる", () => {
    const range = gaugeRange({ ...none, thresholdMinCritical: -20, thresholdMaxCritical: 20 }, {}, 0);
    expect(range.min).toBeLessThan(-20);
    expect(range.max).toBeGreaterThan(20);
  });

  it("しきい値が無ければ、現在値に合う切りのよい範囲（37 → 0〜50、92 → 0〜200）", () => {
    expect(gaugeRange(none, {}, 37)).toEqual({ min: 0, max: 50 });
    expect(gaugeRange(none, {}, 92)).toEqual({ min: 0, max: 200 });
    expect(gaugeRange(none, {}, undefined)).toEqual({ min: 0, max: 100 });
  });

  it("しきい値が無く現在値が負なら、0 を上端にして下へ広げる", () => {
    expect(gaugeRange(none, {}, -37)).toEqual({ min: -50, max: 0 });
  });

  it("しきい値が 1 つだけでも、範囲を作れる（0 を含む）", () => {
    expect(gaugeRange({ ...none, thresholdMaxCritical: 0 }, {}, undefined)).toEqual({ min: 0, max: 1 });
    expect(gaugeRange({ ...none, thresholdMaxCritical: 90 }, {}, undefined)).toEqual({ min: 0, max: 112.5 });
  });

  it("しきい値がすべて負なら、その下から、一番大きいしきい値の少し先まで", () => {
    const range = gaugeRange({ ...none, thresholdMinWarning: -50, thresholdMinCritical: -80 }, {}, undefined);
    expect(range.min).toBeLessThan(-80);
    expect(range.max).toBeGreaterThan(-50);
  });

  it("現在値が範囲の外なら、針が見えるよう広げる", () => {
    expect(gaugeRange(none, { gaugeMin: 0, gaugeMax: 100 }, 300)).toEqual({ min: 0, max: 100 });
    const auto = gaugeRange({ ...none, thresholdMaxCritical: 90 }, {}, 500);
    expect(auto.max).toBeGreaterThanOrEqual(500);
  });
});

describe("gaugeFraction", () => {
  it("範囲の中の位置（0〜1）。外は端に寄せる", () => {
    const range = { min: 0, max: 200 };
    expect(gaugeFraction(50, range)).toBe(0.25);
    expect(gaugeFraction(-5, range)).toBe(0);
    expect(gaugeFraction(999, range)).toBe(1);
  });
});

describe("gaugeZones", () => {
  it("上限の軽故障・重故障: 正常 → 軽故障 → 重故障。位置は範囲に対する割合", () => {
    const zones = gaugeZones({ ...none, thresholdMaxWarning: 80, thresholdMaxCritical: 90 }, { min: 0, max: 100 });
    expect(zones).toEqual([
      { severity: "normal", from: 0, to: 0.8 },
      { severity: "warning", from: 0.8, to: 0.9 },
      { severity: "critical", from: 0.9, to: 1 },
    ]);
  });

  it("しきい値が無ければ、全体が正常", () => {
    expect(gaugeZones(none, { min: 0, max: 100 })).toEqual([{ severity: "normal", from: 0, to: 1 }]);
  });

  it("範囲の外のしきい値では区切らない", () => {
    const zones = gaugeZones({ ...none, thresholdMaxCritical: 500 }, { min: 0, max: 100 });
    expect(zones).toEqual([{ severity: "normal", from: 0, to: 1 }]);
  });

  it("下限もあれば、両端が重故障になる", () => {
    const zones = gaugeZones(
      { thresholdMinCritical: 10, thresholdMinWarning: 20, thresholdMaxWarning: 80, thresholdMaxCritical: 90 },
      { min: 0, max: 100 },
    );
    expect(zones.map((z) => z.severity)).toEqual(["critical", "warning", "normal", "warning", "critical"]);
  });

  it("軽故障と重故障が逆転していても、同じ重さの隣り合う帯は1つにまとめる", () => {
    const zones = gaugeZones({ ...none, thresholdMaxWarning: 90, thresholdMaxCritical: 80 }, { min: 0, max: 100 });
    expect(zones.map((z) => z.severity)).toEqual(["normal", "critical"]);
  });
});

describe("半円の描き方", () => {
  it("0 は左端、1 は右端、0.5 は真上", () => {
    const [x0, y0] = gaugePointAt(0, 80);
    const [xHalf, yHalf] = gaugePointAt(0.5, 80);
    const [x1, y1] = gaugePointAt(1, 80);
    expect(x0).toBeCloseTo(20);
    expect(y0).toBeCloseTo(100);
    expect(xHalf).toBeCloseTo(100);
    expect(yHalf).toBeCloseTo(20);
    expect(x1).toBeCloseTo(180);
    expect(y1).toBeCloseTo(100);
  });

  it("半円全体の弧は、左端から右端へ時計回り（large-arc=0, sweep=1）", () => {
    expect(gaugeArcPath(0, 1)).toBe("M20.00,100.00 A80,80 0 0 1 180.00,100.00");
  });

  it("途中の弧は、その位置の2点を結ぶ", () => {
    expect(gaugeArcPath(0, 0.5)).toBe("M20.00,100.00 A80,80 0 0 1 100.00,20.00");
  });
});
