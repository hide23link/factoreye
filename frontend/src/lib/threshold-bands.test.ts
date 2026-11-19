import { describe, expect, it } from "vitest";

import { bandAt, computeBands, describeBand } from "./threshold-bands";
import type { TrendLimit, TrendPoint } from "./trend-stack";

const MIN = 60_000;
const at = (minute: number, value: number): TrendPoint => ({ time: minute * MIN, value });

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

  it("線の色の切り替わり（levelOf）と同じ点が、帯の端になる", () => {
    const points = [at(0, 39.9), at(10, 40.1), at(20, 40.1), at(30, 39.9)];
    const [band] = computeBands(points, upper);
    expect([band.startMs, band.endMs]).toEqual([10 * MIN, 20 * MIN]);
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
