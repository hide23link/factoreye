import { describe, expect, it } from "vitest";

import {
  formatTick,
  formatTrendValue,
  gapThreshold,
  levelOf,
  linePath,
  niceScale,
  overPath,
  pointNear,
  staleAfterMs,
  timeTicks,
  toPoints,
  trendLimits,
  trendStats,
  xPercent,
  yPercent,
  PLOT_BOTTOM,
  PLOT_TOP,
} from "./trend-stack";

const bucket = (start: string, avg: number, min = avg, max = avg, count = 1) => ({ start, avg, min, max, count });

describe("niceScale（縦軸の目盛り）", () => {
  it("温度 18.4〜23.1 としきい値 18・28 は、16〜30 を 2 ごと", () => {
    const scale = niceScale(18, 28);
    expect(scale.step).toBe(2);
    expect(scale.min).toBe(16);
    expect(scale.max).toBe(30);
    expect(scale.ticks).toEqual([16, 18, 20, 22, 24, 26, 28, 30]);
  });

  it("CO2 520〜1103 を 5 区間までにすると、200 ごとで 400〜1200", () => {
    const scale = niceScale(520, 1103, 5);
    expect(scale.step).toBe(200);
    expect(scale.ticks[0]).toBe(400);
    expect(scale.ticks[scale.ticks.length - 1]).toBe(1200);
  });

  it("小数の間隔でも、目盛りに 0.1+0.2 のような誤差が残らない", () => {
    const scale = niceScale(0.1, 0.9);
    expect(scale.ticks.every((t) => String(t).length <= 4)).toBe(true);
  });

  it("平らな線（最低＝最高）でも、0 で割らずに上下へ広げる", () => {
    const scale = niceScale(5, 5);
    expect(scale.max).toBeGreaterThan(5);
    expect(scale.min).toBeLessThan(5);
  });
});

describe("niceScale の区間の数と小さな値", () => {
  it("区間の数は maxIntervals 以下（0〜1 は 5 区間以内）", () => {
    for (const [lo, hi, n] of [[0, 1, 5], [0, 1, 3], [18, 28, 5], [520, 1103, 4], [-3.2, 7.7, 2]] as const) {
      const scale = niceScale(lo, hi, n);
      expect(scale.ticks.length - 1).toBeLessThanOrEqual(n);
      expect(scale.min).toBeLessThanOrEqual(lo);
      expect(scale.max).toBeGreaterThanOrEqual(hi);
    }
  });

  it("とても小さな値でも、目盛りの文字が重ならず 0 ばかりにならない", () => {
    for (const [lo, hi] of [[0.001, 0.0012], [1e-7, 3e-7]] as const) {
      const scale = niceScale(lo, hi);
      const labels = scale.ticks.map((t) => formatTick(t, scale));
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe("位置の計算", () => {
  const scale = niceScale(16, 30);
  it("縦軸の上端の値は PLOT_TOP%、下端は PLOT_BOTTOM%", () => {
    expect(yPercent(scale.max, scale)).toBeCloseTo(PLOT_TOP);
    expect(yPercent(scale.min, scale)).toBeCloseTo(PLOT_BOTTOM);
  });
  it("時刻は、表示範囲の割合", () => {
    expect(xPercent(150, 100, 200)).toBe(50);
  });
});

describe("toPoints と trendStats", () => {
  const buckets = [
    bucket("2026-11-18T00:00:00Z", 20, 19, 21, 2),
    bucket("2026-11-18T00:10:00Z", 22, 21, 25, 2),
    bucket("2026-11-18T00:20:00Z", 21, 18, 22, 4),
  ];
  const points = toPoints(buckets, 600, "avg");

  it("点は区間の中央の時刻に置く", () => {
    expect(points[0].time).toBe(new Date("2026-11-18T00:05:00Z").getTime());
    expect(points.map((p) => p.value)).toEqual([20, 22, 21]);
  });

  it("最高・最低は区間の max・min（平均の線より正確）、平均は件数で重みを付ける", () => {
    const stats = trendStats(buckets, 600, points);
    expect(stats?.max.value).toBe(25);
    expect(stats?.min.value).toBe(18);
    // (20×2 + 22×2 + 21×4) / 8 = 21
    expect(stats?.average).toBe(21);
    expect(stats?.last.value).toBe(21);
  });

  it("データが無ければ null", () => {
    expect(trendStats([], 600, [])).toBeNull();
  });

  it("最後の区間がまだ終わっていないとき、点・最高・最低の時刻は、今（endTime）より後にしない", () => {
    // 最後の区間は 00:20〜00:30。中央は 00:25 だが、今は 00:23
    const now = new Date("2026-11-18T00:23:00Z").getTime();
    const capped = toPoints(buckets, 600, "avg", now);
    expect(capped[2].time).toBe(now);
    // 終わっている区間は、これまでどおり中央
    expect(capped[0].time).toBe(new Date("2026-11-18T00:05:00Z").getTime());
    // 最後の区間に最低（18）があるので、最低の時刻も今で切られる
    expect(trendStats(buckets, 600, capped, now)?.min.time).toBe(now);
  });
});

describe("しきい値", () => {
  const sensor = { thresholdMaxWarning: 900, thresholdMaxCritical: 1000, thresholdMinWarning: null, thresholdMinCritical: null };
  const limits = trendLimits(sensor);

  it("設定されているものだけを返す", () => {
    expect(limits.map((l) => `${l.side}${l.severity}${l.value}`)).toEqual(["maxcritical1000", "maxwarning900"]);
  });

  it("重故障の外 → critical、軽故障の外 → warning、内 → normal", () => {
    expect(levelOf(1050, limits)).toBe("critical");
    expect(levelOf(950, limits)).toBe("warning");
    expect(levelOf(800, limits)).toBe("normal");
  });
});

describe("線の道筋", () => {
  const scale = niceScale(0, 10);
  const points = [
    { time: 0, value: 1 },
    { time: 10, value: 2 },
    { time: 50, value: 3 },
  ];

  it("点の間が空いた所（受信が無かった間）は線をつながない", () => {
    const path = linePath(points, scale, 0, 100, 20);
    expect(path.match(/M/g)).toHaveLength(2);
  });

  it("超えている部分だけの道筋", () => {
    const path = overPath(points, (v) => v > 1.5, scale, 0, 100);
    expect(path.startsWith("M100.0")).toBe(true);
    expect(overPath(points, () => false, scale, 0, 100)).toBe("");
  });
});

describe("gapThreshold（線を切る長さ）", () => {
  it("区間より間をあけて送る機器（1 分ごと）でも、線を途切れさせない", () => {
    const minute = 60_000;
    const points = [0, 1, 2, 3, 4].map((m) => ({ time: m * minute, value: m }));
    expect(gapThreshold(points, 7_000)).toBe(3 * minute);
  });
  it("点が 1 つなら、区間の幅から決める", () => {
    expect(gapThreshold([{ time: 0, value: 1 }], 10_000)).toBe(25_000);
  });
});

describe("pointNear（カーソルの値）", () => {
  const points = [
    { time: 0, value: 1 },
    { time: 100, value: 2 },
  ];
  it("いちばん近い点", () => {
    expect(pointNear(points, 70, 50)?.value).toBe(2);
  });
  it("離れすぎていれば null（データが無い）", () => {
    expect(pointNear(points, 500, 50)).toBeNull();
  });
});

describe("timeTicks（時間の軸）", () => {
  it("24 時間なら 3 時間ごとの切りのよい時刻", () => {
    const from = new Date(2026, 10, 17, 9, 42).getTime();
    const to = from + 24 * 3_600_000;
    const ticks = timeTicks(from, to);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(ticks.every((t) => new Date(t).getMinutes() === 0 && new Date(t).getHours() % 3 === 0)).toBe(true);
  });
});

describe("文字", () => {
  it("値の桁は目盛りの間隔から（200 → 0 桁、10 や 2 → 1 桁）。設定があればそれ", () => {
    expect(formatTrendValue(96.84, niceScale(60, 100))).toBe("96.8");
    expect(formatTrendValue(1050.4, niceScale(500, 1100))).toBe("1050");
    expect(formatTrendValue(22.44, niceScale(16, 30))).toBe("22.4");
    expect(formatTrendValue(22.44, niceScale(16, 30), 2)).toBe("22.44");
  });
  it("目盛りは間隔と同じ桁（2.5 → 1 桁）", () => {
    const scale = { min: 0, max: 10, step: 2.5, ticks: [] };
    expect(formatTick(7.5, scale)).toBe("7.5");
    expect(formatTick(10, { ...scale, step: 2 })).toBe("10");
  });
});

describe("staleAfterMs（受信なしの判定）", () => {
  it("区間 3 つ分。ただし 10 分より短くしない", () => {
    expect(staleAfterMs(60)).toBe(10 * 60_000);
    expect(staleAfterMs(600)).toBe(30 * 60_000);
  });
});
