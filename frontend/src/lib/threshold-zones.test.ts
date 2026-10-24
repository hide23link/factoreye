import { describe, expect, it } from "vitest";

import { thresholdZones } from "./threshold-zones";

const none = { thresholdMaxWarning: null, thresholdMaxCritical: null, thresholdMinWarning: null, thresholdMinCritical: null };

describe("thresholdZones", () => {
  it("しきい値が1つも無ければ null", () => {
    expect(thresholdZones(none)).toBeNull();
  });

  it("上限だけ（軽故障 80・重故障 90）: 正常 → 軽故障 → 重故障 の3つの帯", () => {
    const zones = thresholdZones({ ...none, thresholdMaxWarning: 80, thresholdMaxCritical: 90 });
    expect(zones?.map((z) => z.severity)).toEqual(["normal", "warning", "critical"]);
    expect(zones?.[0]).toMatchObject({ from: null, to: 80 });
    expect(zones?.[2]).toMatchObject({ from: 90, to: null });
  });

  it("上限と下限の両方: 重故障 → 軽故障 → 正常 → 軽故障 → 重故障", () => {
    const zones = thresholdZones({ thresholdMinCritical: 5, thresholdMinWarning: 10, thresholdMaxWarning: 80, thresholdMaxCritical: 90 });
    expect(zones?.map((z) => z.severity)).toEqual(["critical", "warning", "normal", "warning", "critical"]);
  });

  it("帯の幅の合計は 1。両端はしきい値の幅と同じ長さぶんだけ見せる", () => {
    const zones = thresholdZones({ ...none, thresholdMaxWarning: 0, thresholdMaxCritical: 100 }) ?? [];
    expect(zones.reduce((sum, z) => sum + z.share, 0)).toBeCloseTo(1);
    // 幅 100。両端も 100 ずつで、全体は 300（-100〜200）
    expect(zones[0].share).toBeCloseTo(100 / 300);
    expect(zones[1].share).toBeCloseTo(100 / 300);
  });

  it("しきい値が1つだけ（幅 0）でも、帯を2つに分けられる", () => {
    const zones = thresholdZones({ ...none, thresholdMaxCritical: 10 });
    expect(zones?.map((z) => z.severity)).toEqual(["normal", "critical"]);
    expect(zones?.reduce((sum, z) => sum + z.share, 0)).toBeCloseTo(1);
  });

  it("軽故障と重故障が同じ値でも壊れない（同じ値は1つにまとめる）", () => {
    const zones = thresholdZones({ ...none, thresholdMaxWarning: 50, thresholdMaxCritical: 50 });
    expect(zones?.map((z) => z.severity)).toEqual(["normal", "critical"]);
  });

  it("下限だけ: 重故障 → 軽故障 → 正常", () => {
    const zones = thresholdZones({ ...none, thresholdMinCritical: 5, thresholdMinWarning: 10 });
    expect(zones?.map((z) => z.severity)).toEqual(["critical", "warning", "normal"]);
    expect(zones?.[0]).toMatchObject({ from: null, to: 5 });
    expect(zones?.[2]).toMatchObject({ from: 10, to: null });
  });

  it("軽故障と重故障が逆転していても（上限: 軽故障 90・重故障 80）、アラームと同じ判定で、同じ重さの帯は1つにまとめる", () => {
    const zones = thresholdZones({ ...none, thresholdMaxWarning: 90, thresholdMaxCritical: 80 });
    expect(zones?.map((z) => z.severity)).toEqual(["normal", "critical"]);
    expect(zones?.[1]).toMatchObject({ from: 80, to: null });
    expect(zones?.reduce((sum, z) => sum + z.share, 0)).toBeCloseTo(1);
  });
});
