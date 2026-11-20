import { describe, expect, it } from "vitest";

import { bandAt, computeBands, describeBand, toBandSamples, type BandSample } from "./threshold-bands";
import type { TrendLimit } from "./trend-stack";

const MIN = 60_000;
// 平均だけの区間（最高＝最低＝value）
const at = (minute: number, value: number): BandSample => ({ time: minute * MIN, max: value, min: value });
// 区間の最高・最低が、平均（線の値）と違う区間
const spread = (minute: number, min: number, max: number): BandSample => ({ time: minute * MIN, max, min });

// 上限: 注意 40・警報 50
const upper: TrendLimit[] = [
  { value: 50, side: "max", severity: "critical" },
  { value: 40, side: "max", severity: "warning" },
];
// 下限: 注意 10・警報 5
const lower: TrendLimit[] = [
  { value: 5, side: "min", severity: "critical" },
  { value: 10, side: "min", severity: "warning" },
];

describe("computeBands（しきい値を超えた区間）", () => {
  it("しきい値が無ければ、帯なし", () => {
    expect(computeBands([at(0, 100), at(10, 200)], [])).toEqual([]);
  });

  it("超えていなければ、帯なし", () => {
    expect(computeBands([at(0, 20), at(10, 30)], upper)).toEqual([]);
  });

  it("連続して超えた点を 1 つの帯にし、区間の最悪の段階と最高の値を持つ", () => {
    const bands = computeBands([at(0, 20), at(10, 41), at(20, 55), at(30, 45), at(40, 20)], upper);
    expect(bands).toEqual([{ startMs: 10 * MIN, endMs: 30 * MIN, level: "critical", side: "max", extreme: 55 }]);
  });

  it("注意だけの区間は注意の帯", () => {
    expect(computeBands([at(0, 20), at(10, 42)], upper)).toEqual([{ startMs: 10 * MIN, endMs: 10 * MIN, level: "warning", side: "max", extreme: 42 }]);
  });

  it("間引きで 1 点だけ超えた場合も、帯が出る（始めと終わりが同じ）", () => {
    const bands = computeBands([at(0, 20), at(10, 60), at(20, 20)], upper);
    expect(bands).toHaveLength(1);
    expect(bands[0].startMs).toBe(bands[0].endMs);
  });

  it("正常な点をはさむと、別の帯になる", () => {
    const bands = computeBands([at(0, 45), at(10, 20), at(20, 46)], upper);
    expect(bands.map((band) => [band.startMs, band.endMs])).toEqual([[0, 0], [20 * MIN, 20 * MIN]]);
  });

  it("下限側は、最低の値を extreme にする", () => {
    const bands = computeBands([at(0, 20), at(10, 8), at(20, 3), at(30, 9), at(40, 20)], lower);
    expect(bands).toEqual([{ startMs: 10 * MIN, endMs: 30 * MIN, level: "critical", side: "min", extreme: 3 }]);
  });

  it("受信なし（gapMs より離れた点）をはさんだ区間は、つなげない", () => {
    const bands = computeBands([at(0, 45), at(10, 46), at(60, 47)], upper, 15 * MIN);
    expect(bands.map((band) => [band.startMs, band.endMs])).toEqual([[0, 10 * MIN], [60 * MIN, 60 * MIN]]);
  });

  it("10 分の区間に 1 秒だけ警報値があり、平均は超えていなくても、帯が出る（区間の最高で判定）", () => {
    const bands = computeBands([spread(0, 20, 30), spread(10, 20, 95), spread(20, 20, 30)], upper);
    expect(bands).toEqual([{ startMs: 10 * MIN, endMs: 10 * MIN, level: "critical", side: "max", extreme: 95 }]);
  });

  it("平均が超えている区間でも、帯が出る", () => {
    expect(computeBands([spread(0, 44, 48), spread(10, 44, 48)], upper)).toHaveLength(1);
  });

  it("下限側は、区間の最低で判定する（最高が内側でも、最低が下限を割れば帯）", () => {
    const bands = computeBands([spread(0, 20, 30), spread(10, 2, 30), spread(20, 20, 30)], lower);
    expect(bands).toEqual([{ startMs: 10 * MIN, endMs: 10 * MIN, level: "critical", side: "min", extreme: 2 }]);
  });

  it("上限側のしきい値だけのときは、最低が低くても帯にならない", () => {
    expect(computeBands([spread(0, -100, 30)], upper)).toEqual([]);
  });

  it("値が数でない区間（欠け）は読み飛ばし、前後が超えていれば 1 つの帯のまま", () => {
    const bands = computeBands([at(0, 45), { time: 10 * MIN, max: NaN, min: NaN }, at(20, 46)], upper);
    expect(bands.map((band) => [band.startMs, band.endMs])).toEqual([[0, 20 * MIN]]);
  });

  it("toBandSamples は、区間の中央の時刻に区間の最高・最低を置く（endTime より後にはしない）", () => {
    const start = "2026-11-20T00:00:00.000Z";
    const t0 = Date.parse(start);
    expect(toBandSamples([{ start, max: 9, min: 1 }], 600)).toEqual([{ time: t0 + 300_000, max: 9, min: 1 }]);
    expect(toBandSamples([{ start, max: 9, min: 1 }], 600, t0 + 100_000)[0].time).toBe(t0 + 100_000);
  });
});

describe("bandAt（カーソルの時刻の帯）", () => {
  const bands = computeBands([at(0, 20), at(10, 60), at(20, 60), at(30, 20), at(40, 70), at(50, 20)], upper);

  it("帯の中の時刻なら、その帯", () => {
    expect(bandAt(bands, 15 * MIN)?.extreme).toBe(60);
  });

  it("帯の外なら null", () => {
    expect(bandAt(bands, 25 * MIN)).toBeNull();
  });

  it("1 点だけの帯は、余裕（toleranceMs）の中なら拾う", () => {
    expect(bandAt(bands, 41 * MIN)).toBeNull();
    expect(bandAt(bands, 41 * MIN, 2 * MIN)?.extreme).toBe(70);
  });
});

describe("describeBand（帯の説明）", () => {
  const time = (ms: number) => `${String(Math.floor(ms / MIN / 60)).padStart(2, "0")}:${String((ms / MIN) % 60).padStart(2, "0")}`;
  const value = (v: number) => v.toFixed(1);

  it("警報の上限側は「警報 11:42〜12:58 最高 89.2」", () => {
    const band = { startMs: (11 * 60 + 42) * MIN, endMs: (12 * 60 + 58) * MIN, level: "critical" as const, side: "max" as const, extreme: 89.2 };
    expect(describeBand(band, time, value)).toBe("警報 11:42〜12:58 最高 89.2");
  });

  it("注意の下限側は「注意 … 最低 …」、1 点だけの帯は時刻を 1 つだけ出す", () => {
    const band = { startMs: 3 * 60 * MIN, endMs: 3 * 60 * MIN, level: "warning" as const, side: "min" as const, extreme: 4.1 };
    expect(describeBand(band, time, value)).toBe("注意 03:00 最低 4.1");
  });
});
