import { describe, expect, it } from "vitest";

import {
  MAX_STRIP_CELLS,
  bucketTarget,
  buildCells,
  buildIntervalCells,
  intervalFetchRange,
  stripSettingsFromConfig,
  stripWindow,
  summarizeCells,
  type DownsampledBucketLike,
  type StripCell,
} from "./target-strip";

// 2026-11-02 12:07:30 JST（ローカル時間で組み立てる。分の境界は時刻のずれに依存しない）
const NOW = new Date(2026, 10, 2, 12, 7, 30).getTime();
const MIN = 60000;
// 表示範囲は、グラフと同じ「今から hours 時間前〜今」
const rangeOf = (hours: number) => ({ from: NOW - hours * 60 * MIN, to: NOW });

function bucketAt(window: { from: number; bucketMs: number }, index: number, sum: number, count = 1): DownsampledBucketLike {
  return { start: new Date(window.from + index * window.bucketMs).toISOString(), avg: sum / count, count };
}

describe("stripSettingsFromConfig", () => {
  it("未設定は、件数の判定（1 分・1 時間 60）", () => {
    expect(stripSettingsFromConfig({})).toEqual({
      bucketMinutes: 1,
      hourlyTarget: 60,
      workOnly: false,
      tolerant: false,
      judge: "count",
      maxGapSeconds: 90,
    });
  });
  it("範囲外の間隔・期間は初期値に寄せる", () => {
    const s = stripSettingsFromConfig({ stripBucketMinutes: 7, stripHourlyTarget: -3 });
    expect(s).toMatchObject({ bucketMinutes: 1, hourlyTarget: 60 });
  });
  it("目標 0 以下は認めない（常に達成になって未達を隠すため）。初期値に寄せる", () => {
    expect(stripSettingsFromConfig({ stripHourlyTarget: 0 }).hourlyTarget).toBe(60);
    expect(stripSettingsFromConfig({ stripHourlyTarget: -5 }).hourlyTarget).toBe(60);
  });
});

describe("bucketTarget / stripWindow", () => {
  it("1 マスの目標 = 1 時間の目標 × 間隔 ÷ 60", () => {
    expect(bucketTarget(60, 1)).toBe(1);
    expect(bucketTarget(120, 5)).toBe(10);
    expect(bucketTarget(100, 10)).toBeCloseTo(16.667, 2);
  });
  it("範囲はマスの境界に合い、最後のマスが今を含む", () => {
    const w = stripWindow(rangeOf(2), 5);
    expect(w.bucketMinutes).toBe(5);
    expect(w.from % (5 * MIN)).toBe(0);
    expect(w.to % (5 * MIN)).toBe(0);
    expect(w.to).toBeGreaterThan(NOW);
    expect(w.to - NOW).toBeLessThanOrEqual(5 * MIN);
    expect(w.from).toBeLessThanOrEqual(NOW - 2 * 60 * MIN);
    expect(w.bucketCount).toBe(Math.round((w.to - w.from) / (5 * MIN)));
  });
  it("ちょうど境界の時刻でも、今のマスは次のマス", () => {
    const boundary = Math.floor(NOW / MIN) * MIN;
    expect(stripWindow({ from: boundary - 60 * MIN, to: boundary }, 1).to).toBe(boundary + MIN);
  });
  it("表示期間が長くてマスが多すぎるときは、マスの長さを自動で広げる", () => {
    const day = stripWindow(rangeOf(24), 1); // 24 時間 × 1 分 = 1,440 マス → 広げる
    expect(day.bucketCount).toBeLessThanOrEqual(MAX_STRIP_CELLS);
    expect(day.bucketMinutes).toBe(5);
    const month = stripWindow(rangeOf(24 * 30), 1);
    expect(month.bucketCount).toBeLessThanOrEqual(MAX_STRIP_CELLS);
    expect(month.bucketMinutes).toBeGreaterThanOrEqual(60);
  });
  it("設定より短いマスにはしない（10 分の設定なら、短い期間でも 10 分）", () => {
    expect(stripWindow(rangeOf(1), 10).bucketMinutes).toBe(10);
  });
});

describe("buildCells（受信の確認: 1 分・値 1）", () => {
  const settings = stripSettingsFromConfig({});
  const tolerant = stripSettingsFromConfig({ stripTolerant: true });
  const window = stripWindow(rangeOf(2), 1);
  const last = window.bucketCount - 1;

  it("値が来たマスは緑、来なかった完結したマスは赤、今のマスで未到達は集計中", () => {
    // 最後のマス=今 → データなし。1 つ前は受信あり。2 つ前は受信なし
    const buckets = [bucketAt(window, last - 1, 1), bucketAt(window, last - 3, 1)];
    const cells = buildCells(buckets, window, NOW, settings, {}, null);
    expect(cells[last].state).toBe("pending");
    expect(cells[last - 1].state).toBe("ok");
    expect(cells[last - 2].state).toBe("short");
    expect(cells[last - 3].state).toBe("ok");
  });

  it("今のマスでもすでに満たしていれば緑", () => {
    const cells = buildCells([bucketAt(window, last, 1)], window, NOW, settings, {}, null);
    expect(cells[last].state).toBe("ok");
  });

  it("センサーを作る前のマスと、作った時刻をまたぐマスは対象外（未達にしない）", () => {
    const created = window.from + 100 * MIN + 30000; // マス 100 の途中
    const cells = buildCells([], window, NOW, settings, {}, created);
    expect(cells[50].state).toBe("off");
    expect(cells[100].state).toBe("off");
    expect(cells[105].state).toBe("short");
  });

  it("既定は厳密: 2 回の次が 0 回も、0 回の次が 2 回も、0 回のマスは赤", () => {
    const afterTwo = buildCells([bucketAt(window, 100, 2, 2)], window, NOW, settings, {}, null);
    expect(afterTwo[100].state).toBe("ok");
    expect(afterTwo[101].state).toBe("short");
    const beforeTwo = buildCells([bucketAt(window, 101, 2, 2)], window, NOW, settings, {}, null);
    expect(beforeTwo[100].state).toBe("short");
  });

  it("1 分のマスは、前のマスの余りを 1 マス分まで繰り越す（受信の揺れで赤にしない）", () => {
    // マス 100 に 2 回、101 に 0 回 → 101 は余りで緑。102 も 0 回 → 余りが無いので赤
    const buckets = [bucketAt(window, 100, 2, 2), bucketAt(window, 99, 1)];
    const cells = buildCells(buckets, window, NOW, tolerant, {}, null);
    expect(cells[100].state).toBe("ok");
    expect(cells[101].state).toBe("ok");
    expect(cells[102].state).toBe("short");
  });

  it("遅れて届いた分も融通する（0 回の次が 2 回なら、前のマスを緑にする）", () => {
    const cells = buildCells([bucketAt(window, 101, 2, 2), bucketAt(window, 99, 1)], window, NOW, tolerant, {}, null);
    expect(cells[100].state).toBe("ok");
    expect(cells[101].state).toBe("ok");
  });

  it("0 回・2 回・0 回なら、最後は赤（2 回で救えるのは 1 マスだけ）", () => {
    const cells = buildCells([bucketAt(window, 101, 2, 2), bucketAt(window, 99, 1)], window, NOW, tolerant, {}, null);
    expect(cells[100].state).toBe("ok");
    expect(cells[102].state).toBe("short");
  });

  it("2 マス続けて空けば、どちらも赤のまま", () => {
    const cells = buildCells([bucketAt(window, 99, 1)], window, NOW, tolerant, {}, null);
    expect(cells[100].state).toBe("short");
    expect(cells[101].state).toBe("short");
  });

  it("余りは 1 マス分まで。3 回来ても、2 マス続けて空けば赤", () => {
    const cells = buildCells([bucketAt(window, 100, 3, 3)], window, NOW, tolerant, {}, null);
    expect(cells[101].state).toBe("ok");
    expect(cells[102].state).toBe("short");
  });
});

describe("buildCells（生産の目標: 5 分・1 時間 120 → 1 マス 10 個）", () => {
  const settings = stripSettingsFromConfig({ stripBucketMinutes: 5, stripHourlyTarget: 120 });
  const window = stripWindow(rangeOf(2), 5);
  const last = window.bucketCount - 1;

  it("合計が目標以上なら緑、未満なら赤（合計 = 平均 × 件数）", () => {
    const buckets = [bucketAt(window, last - 1, 10, 5), bucketAt(window, last - 2, 9, 3), bucketAt(window, last - 3, 12, 4)];
    const cells = buildCells(buckets, window, NOW, settings, {}, null);
    expect(cells[last - 1].state).toBe("ok"); // 10 = 目標ちょうど
    expect(cells[last - 2].state).toBe("short"); // 9 < 10
    expect(cells[last - 3].state).toBe("ok"); // 12
  });

  it("5 分以上のマスは繰り越さない（厳密に判定）", () => {
    // 1 つ前のマスに 25 個（目標 10 の 2.5 倍）、その次は 0 個 → 余りを繰り越さず赤
    const cells = buildCells([bucketAt(window, last - 2, 25, 5)], window, NOW, settings, {}, null);
    expect(cells[last - 2].state).toBe("ok");
    expect(cells[last - 1].state).toBe("short");
  });

  it("勤務時間に一部だけかかるマスは、稼働時間の割合に目標を減らして判定する", () => {
    // 昼休みを 45 分（12:00〜12:45）にして、10 分マス 12:40〜12:50 は稼働 5 分 → 目標 5 個
    const lunch = stripSettingsFromConfig({ stripBucketMinutes: 10, stripHourlyTarget: 60, stripWorkOnly: true });
    const lunchNow = new Date(2026, 10, 2, 14, 0, 0).getTime();
    const w = stripWindow({ from: lunchNow - 6 * 60 * MIN, to: lunchNow }, 10);
    const cellAt = (h: number, m: number) => (new Date(2026, 10, 2, h, m).getTime() - w.from) / w.bucketMs;
    const config = { workStartHour: 8, workEndHour: 17, breakMinutes: 45 };
    const idx = cellAt(12, 40);
    const buckets = [{ start: new Date(w.from + idx * w.bucketMs).toISOString(), avg: 5, count: 1 }];
    const cells = buildCells(buckets, w, lunchNow, lunch, config, null);
    expect(cells[idx].state).toBe("ok"); // 5 個 ≥ 5（半分の目標）
    expect(cells[cellAt(12, 10)].state).toBe("off"); // 昼休み中
  });

  it("勤務時間だけ判定: 時間外は対象外", () => {
    const work = stripSettingsFromConfig({ stripBucketMinutes: 5, stripHourlyTarget: 120, stripWorkOnly: true });
    const config = { workStartHour: 13, workEndHour: 17 }; // 12:07 は勤務前
    const cells = buildCells([], window, NOW, work, config, null);
    expect(cells.every((c) => c.state === "off")).toBe(true);
  });
});

describe("summarizeCells", () => {
  const cell = (state: StripCell["state"]): StripCell => ({ startMs: 0, sum: 0, state });

  it("達成率は、判定したマス（達成+未達）に対する割合", () => {
    const s = summarizeCells([cell("ok"), cell("ok"), cell("short"), cell("pending"), cell("off")]);
    expect(s).toMatchObject({ judged: 3, okCount: 2, shortCount: 1, percent: 67 });
  });
  it("判定したマスが無ければ達成率は null", () => {
    expect(summarizeCells([cell("off"), cell("pending")]).percent).toBeNull();
  });
  it("丸印: 末尾の未達の連続で決まる（集計中・対象外は飛ばす）", () => {
    expect(summarizeCells([cell("ok"), cell("ok"), cell("pending")]).level).toBe("ok");
    expect(summarizeCells([cell("ok"), cell("short"), cell("pending")]).level).toBe("warn");
    expect(summarizeCells([cell("ok"), cell("short"), cell("short"), cell("pending")]).level).toBe("warn");
    expect(summarizeCells([cell("ok"), cell("short"), cell("off"), cell("short"), cell("short"), cell("pending")]).level).toBe("bad");
  });
});

describe("buildIntervalCells（受信の間隔）", () => {
  const settings = stripSettingsFromConfig({ stripJudge: "interval", stripMaxGapSeconds: 90 });
  const window = stripWindow(rangeOf(1), 1);
  const fetchFrom = intervalFetchRange(window, 90).from;
  const SEC = 1000;
  // 60 秒おきの受信を、from〜to の間に並べる（offset 秒ずらせる）
  const every60 = (from: number, to: number, offsetSec = 0) => {
    const out: number[] = [];
    for (let t = from + offsetSec * SEC; t < to; t += 60 * SEC) out.push(t);
    return out;
  };
  const build = (times: number[], createdAt: number | null = null, truncatedFrom: number | null = null) =>
    buildIntervalCells(times, window, NOW, settings, {}, createdAt, fetchFrom, truncatedFrom);

  it("60 秒おきなら全部緑（分の境目をまたいでも、赤にならない）", () => {
    // 分の境目 xx:59.2 と xx:00.2 が交互に来る（実機の atom04 と同じ形）。間隔は 59〜61 秒
    const base = Math.floor(fetchFrom / MIN) * MIN - 1000; // xx:59
    const times: number[] = [];
    for (let t = base, i = 0; t < NOW; i++) { times.push(t + (i === 3 ? 1100 : 0)); t += 60 * SEC + (i === 3 ? 100 : 0); }
    const cells = build(times);
    expect(cells.every((c) => c.state === "ok")).toBe(true);
  });

  it("1 回抜けて 141 秒あくと、その間の途切れた時間にかかるマスだけ赤", () => {
    const all = every60(fetchFrom, NOW, 10);
    const gapStart = all[20]; // この受信の次が 141 秒後
    const times = [...all.slice(0, 21), gapStart + 141 * SEC, ...every60(gapStart + 141 * SEC + 60 * SEC, NOW)];
    const cells = build(times);
    const reds = cells.filter((c) => c.state === "short");
    // 途切れた時間 = [gapStart + 90 秒, gapStart + 141 秒)。51 秒なので、1〜2 マス
    expect(reds.length).toBeGreaterThanOrEqual(1);
    expect(reds.length).toBeLessThanOrEqual(2);
    for (const red of reds) {
      expect(red.startMs).toBeGreaterThanOrEqual(Math.floor((gapStart + 90 * SEC) / MIN) * MIN);
      expect(red.startMs).toBeLessThan(gapStart + 141 * SEC);
    }
    expect(cells.filter((c) => c.state === "ok").length).toBe(cells.length - reds.length);
  });

  it("65〜77 秒の遅れでは赤にならない（実機で見えた小さな遅れ）", () => {
    const base = every60(fetchFrom, NOW, 5);
    const times = [...base.slice(0, 10), base[9] + 77 * SEC, ...base.slice(11).map((t) => t + 17 * SEC)];
    expect(build(times).every((c) => c.state === "ok")).toBe(true);
  });

  it("今の受信が途切れていれば、今のマスも赤（集計中にはしない）", () => {
    const times = every60(fetchFrom, NOW - 5 * MIN);
    const cells = build(times);
    expect(cells[cells.length - 1].state).toBe("short");
    expect(cells[cells.length - 3].state).toBe("short"); // 受信が止まって 90 秒を過ぎた時間にかかる
    expect(cells[cells.length - 10].state).toBe("ok"); // 止まる前
    expect(cells[0].state).toBe("ok");
  });

  it("受信がまったく無ければ、センサーを作ったあとのマスは赤、作る前は対象外", () => {
    const created = window.from + 30 * MIN + 5000;
    const cells = build([], created);
    expect(cells[10].state).toBe("off");
    expect(cells[30].state).toBe("off"); // 作った時刻をまたぐマス
    expect(cells[40].state).toBe("short");
  });

  it("件数の上限で古い側が欠けたときは、読めた最も古い受信より前を対象外にする", () => {
    const times = every60(window.from + 20 * MIN, NOW);
    const cells = build(times, null, times[0]);
    expect(cells[5].state).toBe("off");
    expect(cells[25].state).toBe("ok");
  });

  it("受信の数をマスごとに数える", () => {
    const times = every60(fetchFrom, NOW, 10);
    const cells = build(times);
    expect(cells.slice(1, -1).every((c) => c.sum === 1)).toBe(true);
  });
});
