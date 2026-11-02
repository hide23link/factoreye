import { describe, expect, it } from "vitest";

import {
  MAX_STRIP_CELLS,
  bucketTarget,
  buildCells,
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
  it("未設定は受信の確認（1 分・1 時間 60・2 時間）", () => {
    expect(stripSettingsFromConfig({})).toEqual({ bucketMinutes: 1, hourlyTarget: 60, workOnly: false });
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

  it("1 分のマスは、前のマスの余りを 1 マス分まで繰り越す（受信の揺れで赤にしない）", () => {
    // マス 100 に 2 回、101 に 0 回 → 101 は余りで緑。102 も 0 回 → 余りが無いので赤
    const buckets = [bucketAt(window, 100, 2, 2), bucketAt(window, 99, 1)];
    const cells = buildCells(buckets, window, NOW, settings, {}, null);
    expect(cells[100].state).toBe("ok");
    expect(cells[101].state).toBe("ok");
    expect(cells[102].state).toBe("short");
  });

  it("遅れて届いた分も融通する（0 回の次が 2 回なら、前のマスを緑にする）", () => {
    const cells = buildCells([bucketAt(window, 101, 2, 2), bucketAt(window, 99, 1)], window, NOW, settings, {}, null);
    expect(cells[100].state).toBe("ok");
    expect(cells[101].state).toBe("ok");
  });

  it("0 回・2 回・0 回なら、最後は赤（2 回で救えるのは 1 マスだけ）", () => {
    const cells = buildCells([bucketAt(window, 101, 2, 2), bucketAt(window, 99, 1)], window, NOW, settings, {}, null);
    expect(cells[100].state).toBe("ok");
    expect(cells[102].state).toBe("short");
  });

  it("2 マス続けて空けば、どちらも赤のまま", () => {
    const cells = buildCells([bucketAt(window, 99, 1)], window, NOW, settings, {}, null);
    expect(cells[100].state).toBe("short");
    expect(cells[101].state).toBe("short");
  });

  it("余りは 1 マス分まで。3 回来ても、2 マス続けて空けば赤", () => {
    const cells = buildCells([bucketAt(window, 100, 3, 3)], window, NOW, settings, {}, null);
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
