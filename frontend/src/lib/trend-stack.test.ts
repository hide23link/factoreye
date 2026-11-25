import { describe, expect, it } from "vitest";

import type { GraphRow } from "./graph-series";

import {
  breakAtGaps,
  formatCursorTime,
  seriesLineRows,
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
  boxesOverlap,
  describeInterval,
  describeSpanShort,
  estimateTextWidth,
  placeCursorLabel,
  placeExtremeLabels,
  placeLabelAround,
  placeTimeLabel,
  shownCursorTime,
  formatRangeJst,
  maxTimeTicks,
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

describe("時間の軸の目盛りの数（スマホの狭い幅）", () => {
  it("幅から目盛りの数の上限を決める（64px に 1 つ。2〜8）", () => {
    expect(maxTimeTicks(320)).toBe(5);
    expect(maxTimeTicks(100)).toBe(2);
    expect(maxTimeTicks(2000)).toBe(8);
    expect(maxTimeTicks(0)).toBe(8);
  });

  it("上限を小さくすると、目盛りの間隔が広がり、数が上限以下になる", () => {
    const from = new Date(2026, 10, 17, 9, 42).getTime();
    const to = from + 24 * 3_600_000;
    expect(timeTicks(from, to, 4).length).toBeLessThanOrEqual(4);
    expect(timeTicks(from, to, 4).length).toBeLessThan(timeTicks(from, to, 8).length + 1);
  });
});

describe("見出しの文字", () => {
  it("区間の幅（5 分・30 秒・2 時間）", () => {
    expect(describeInterval(300_000)).toBe("5 分");
    expect(describeInterval(30_000)).toBe("30 秒");
    expect(describeInterval(7_200_000)).toBe("2 時間");
  });
  it("表示範囲の短い名前（24H・15M・7D）", () => {
    expect(describeSpanShort(24 * 3_600_000)).toBe("24H");
    expect(describeSpanShort(15 * 60_000)).toBe("15M");
    expect(describeSpanShort(7 * 24 * 3_600_000)).toBe("7D");
  });
  it("範囲の始めと終わりは日本時間で、JST を付ける", () => {
    // 2026-11-17 00:42 UTC = 09:42 JST
    const from = Date.UTC(2026, 10, 17, 0, 42);
    expect(formatRangeJst(from, from + 24 * 3_600_000)).toBe("11/17 09:42 — 11/18 09:42 JST");
  });
});

describe("札の置き場所（最高・最低・カーソルの値）", () => {
  const plot = { width: 400, height: 100 };

  it("文字の幅は、全角を文字の大きさ、半角を 0.62 倍で見積もる", () => {
    expect(estimateTextWidth("最高", 10)).toBe(20);
    expect(estimateTextWidth("1103", 10)).toBe(Math.ceil(4 * 6.2));
  });

  it("左の端（15% 付近）でも、札は枠の外へ切れない", () => {
    const box = placeLabelAround({ x: 10, y: 60 }, { width: 80, height: 14 }, "above", plot);
    expect(box.left).toBe(0);
    const right = placeLabelAround({ x: 395, y: 60 }, { width: 80, height: 14 }, "above", plot);
    expect(right.left + right.width).toBe(400);
  });

  it("最高は点の上・最低は点の下が優先。上端の最高は下に、下端の最低は上に置く（行が低くても枠の外へ出ない）", () => {
    const low = { width: 400, height: 64 };
    const placed = placeExtremeLabels({ max: { x: 100, y: 4, width: 70 }, min: { x: 300, y: 62, width: 70 }, cursor: null, plot: low });
    expect(placed.max.box.top).toBeGreaterThan(4); // 点の下
    expect(placed.min.box.top + placed.min.box.height).toBeLessThan(62); // 点の上
    expect(placed.max.box.top).toBeGreaterThanOrEqual(0);
    expect(placed.min.box.top + placed.min.box.height).toBeLessThanOrEqual(low.height);
  });

  it("最高と最低が近くて同じ側だと重なるときは、最低を反対側へ逃がす（重ならない）", () => {
    const placed = placeExtremeLabels({ max: { x: 200, y: 50, width: 70 }, min: { x: 210, y: 52, width: 70 }, cursor: null, plot });
    expect(boxesOverlap(placed.max.box, placed.min.box)).toBe(false);
    expect(placed.max.faded).toBe(false);
    expect(placed.min.faded).toBe(false);
  });

  it("カーソルの札を優先し、重なる最高・最低の札は反対側へ逃がす", () => {
    const cursor = placeCursorLabel({ x: 200, y: 40 }, { width: 60, height: 18 }, plot);
    const placed = placeExtremeLabels({ max: { x: 230, y: 40, width: 70 }, min: { x: 20, y: 90, width: 70 }, cursor, plot });
    expect(boxesOverlap(placed.max.box, cursor)).toBe(false);
    expect(placed.max.faded).toBe(false);
  });

  it("どこに置いてもカーソルの札に重なるときは、薄くする", () => {
    // 札を置ける所がほとんど無い低い枠で、カーソルの札が全面を覆う
    const tiny = { width: 80, height: 20 };
    const cursor = { left: 0, top: 0, width: 80, height: 20 };
    const placed = placeExtremeLabels({ max: { x: 40, y: 10, width: 70 }, min: { x: 40, y: 10, width: 70 }, cursor, plot: tiny });
    expect(placed.max.faded).toBe(true);
  });

  it("カーソルの札は、右寄りでは点の左・上寄りでは点の下に置く", () => {
    const right = placeCursorLabel({ x: 350, y: 80 }, { width: 60, height: 18 }, plot);
    expect(right.left + right.width).toBeLessThanOrEqual(350);
    const top = placeCursorLabel({ x: 100, y: 10 }, { width: 60, height: 18 }, plot);
    expect(top.top).toBeGreaterThan(10);
  });
});

describe("カーソルの時刻（全グラフで共有）", () => {
  it("共有の時刻が無ければ、表示範囲の右端（現在位置）。あれば範囲の中に収める", () => {
    expect(shownCursorTime(null, 0, 100)).toBe(100);
    expect(shownCursorTime(40, 0, 100)).toBe(40);
    expect(shownCursorTime(150, 0, 100)).toBe(100);
    expect(shownCursorTime(-5, 0, 100)).toBe(0);
  });

  it("時刻の札は、縦線の真下に中心を合わせ、左端・右端では内側へ寄せる", () => {
    expect(placeTimeLabel(200, 50, 400)).toEqual({ left: 175, top: 0, width: 50, height: 16 });
    expect(placeTimeLabel(5, 50, 400).left).toBe(0);
    const right = placeTimeLabel(399, 50, 400);
    expect(right.left + right.width).toBe(400);
  });
});

describe("breakAtGaps・seriesLineRows（受信が止まった所の線を切る。ふつうのグラフ・複数のグラフ）", () => {
  const MINUTE = 60_000;
  const rows = (minutes: number[]) => minutes.map((m) => ({ time: m * MINUTE, value: m as number | null }));

  it("点の間が区間 2.5 個分より空いた所の真ん中に、値の無い行を 1 つ入れる", () => {
    const result = breakAtGaps(rows([0, 1, 2, 3, 10, 11]), MINUTE, (time) => ({ time, value: null }));
    expect(result.map((row) => row.value)).toEqual([0, 1, 2, 3, null, 10, 11]);
    expect(result[4].time).toBe(6.5 * MINUTE);
  });

  it("止まっていなければ、行はそのまま（入れない）", () => {
    expect(breakAtGaps(rows([0, 1, 2, 3]), MINUTE, (time) => ({ time, value: null })).map((row) => row.value)).toEqual([0, 1, 2, 3]);
  });

  it("送る間隔が区間より長い機器（3 分ごと）は、間隔の 3 倍までは切らない（計器グラフの gapThreshold と同じ）", () => {
    expect(breakAtGaps(rows([0, 3, 6, 9]), MINUTE, (time) => ({ time, value: null })).map((row) => row.value)).toEqual([0, 3, 6, 9]);
    expect(breakAtGaps(rows([0, 3, 6, 9, 30]), MINUTE, (time) => ({ time, value: null })).map((row) => row.value)).toEqual([0, 3, 6, 9, null, 30]);
  });

  it("seriesLineRows: そのセンサーの値がある行だけを取り出し、止まった所に null の行を入れる（ほかのセンサーの行は入れない）", () => {
    const graphRows: GraphRow[] = [
      { time: 0, a: 1, b: 5 },
      { time: MINUTE, a: 2 },
      { time: 2 * MINUTE, a: 3, b: 6 },
      { time: 3 * MINUTE, b: 6 },
      { time: 10 * MINUTE, a: 4, b: 7 },
    ];
    expect(seriesLineRows(graphRows, "a", MINUTE)).toEqual([
      { time: 0, a: 1, b: 5 },
      { time: MINUTE, a: 2 },
      { time: 2 * MINUTE, a: 3, b: 6 },
      { time: 6 * MINUTE, a: null },
      { time: 10 * MINUTE, a: 4, b: 7 },
    ]);
  });
});

describe("formatCursorTime（カーソルの札の時刻）", () => {
  const time = new Date(2026, 10, 25, 10, 41, 23).getTime();

  it("表示範囲が 1 時間より短い（拡大した）ときだけ、秒まで出す", () => {
    expect(formatCursorTime(time, 15 * 60_000)).toBe("10:41:23");
    expect(formatCursorTime(time, 59 * 60_000)).toBe("10:41:23");
  });

  it("1 時間ちょうど・6 時間・24 時間は、今までどおり時:分（1 日を超えると日付つき）", () => {
    expect(formatCursorTime(time, 60 * 60_000)).toBe("10:41");
    expect(formatCursorTime(time, 6 * 3_600_000)).toBe("10:41");
    expect(formatCursorTime(time, 24 * 3_600_000)).toBe("10:41");
    expect(formatCursorTime(time, 3 * 24 * 3_600_000)).toBe("11/25 10:41");
  });
});
