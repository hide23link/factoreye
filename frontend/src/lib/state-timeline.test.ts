import { describe, expect, it } from "vitest";

import {
  bucketCell,
  buildSegments,
  buildTimelineCells,
  describeSegment,
  fillShortGaps,
  stateLabel,
  uptimePercent,
  type TimelineCell,
} from "./state-timeline";
import type { TrendLimit } from "./trend-stack";

const MAX_LIMITS: TrendLimit[] = [
  { value: 90, side: "max", severity: "critical" },
  { value: 70, side: "max", severity: "warning" },
];
const b = (min: number, max: number, count = 3) => ({ min, max, count });

describe("bucketCell（区間の状態。受信なし > 警報 > 停止 > 稼働）", () => {
  it("区間が無い・件数 0 は受信なし（警報・停止の値でも受信なしが先）", () => {
    expect(bucketCell(undefined, MAX_LIMITS, 0).state).toBe("none");
    expect(bucketCell(b(0, 0, 0), MAX_LIMITS, 0).state).toBe("none");
  });

  it("値を受信していて、警報でも停止でもなければ稼働", () => {
    expect(bucketCell(b(10, 20), MAX_LIMITS, null).state).toBe("running");
    expect(bucketCell(b(10, 20), [], 5).state).toBe("running");
  });

  it("しきい値の超過は警報。重故障は赤（critical）、軽故障は橙（warning）", () => {
    expect(bucketCell(b(10, 95), MAX_LIMITS, null)).toEqual({ state: "alarm", level: "critical" });
    expect(bucketCell(b(10, 75), MAX_LIMITS, null)).toEqual({ state: "alarm", level: "warning" });
  });

  it("下限を割った谷も警報にする（区間の最低で見る）", () => {
    const limits: TrendLimit[] = [{ value: 5, side: "min", severity: "warning" }];
    expect(bucketCell(b(2, 30), limits, null)).toEqual({ state: "alarm", level: "warning" });
  });

  it("警報は停止より優先する", () => {
    // 停止とみなす値 100 以下だが、95 は重故障の上限を超えている
    expect(bucketCell(b(50, 95), MAX_LIMITS, 100).state).toBe("alarm");
  });

  it("停止は、停止とみなす値を設定した行だけ。区間の最高がその値以下なら停止", () => {
    expect(bucketCell(b(0, 0), [], null).state).toBe("running");
    expect(bucketCell(b(0, 0), [], 0).state).toBe("stopped");
    expect(bucketCell(b(0, 2), [], 1).state).toBe("running");
    expect(bucketCell(b(0, 1), [], 1).state).toBe("stopped");
  });
});

describe("buildTimelineCells", () => {
  const FROM = Date.UTC(2024, 0, 1, 0, 0);
  const TO = FROM + 10 * 60_000;
  const bucketAt = (minute: number, min: number, max: number) => ({
    start: new Date(FROM + minute * 60_000).toISOString(),
    min,
    max,
    count: 1,
  });

  it("開始時刻で区間に入れる。120 秒未満の欠けは前の状態を引き継ぎ、長い欠けは受信なし", () => {
    const cells = buildTimelineCells([bucketAt(0, 1, 1), bucketAt(2, 1, 1)], FROM, TO, 10, [], null);
    expect(cells.map((c) => c.state)).toEqual([
      "running", "running", "running", "none", "none", "none", "none", "none", "none", "none",
    ]);
  });

  it("最後の区間より後ろにはみ出した開始時刻は、最後の区間に入れる", () => {
    const cells = buildTimelineCells([bucketAt(10, 1, 1)], FROM, TO, 10, [], null);
    expect(cells[9].state).toBe("running");
  });
});

describe("buildSegments", () => {
  const FROM = Date.UTC(2024, 0, 1, 0, 0);
  const cell = (state: TimelineCell["state"], level?: TimelineCell["level"]): TimelineCell => ({ state, level });

  it("同じ状態が続く区間を 1 本にまとめ、位置と幅を割合で返す", () => {
    const to = FROM + 4 * 60_000;
    const segments = buildSegments([cell("running"), cell("running"), cell("none"), cell("running")], FROM, to);
    expect(segments.map((s) => [s.state, s.leftPercent, s.widthPercent])).toEqual([
      ["running", 0, 50],
      ["none", 50, 25],
      ["running", 75, 25],
    ]);
    expect(segments[0].endMs - segments[0].startMs).toBe(2 * 60_000);
  });

  it("警報は段階が違えば別の帯にする", () => {
    const segments = buildSegments([cell("alarm", "warning"), cell("alarm", "critical")], FROM, FROM + 120_000);
    expect(segments).toHaveLength(2);
  });
});

describe("uptimePercent", () => {
  it("稼働の区間 ÷ 全区間。受信なし・警報・停止は稼働に数えない", () => {
    const cells: TimelineCell[] = [{ state: "running" }, { state: "running" }, { state: "none" }, { state: "stopped" }];
    expect(uptimePercent(cells)).toBe(50);
    expect(uptimePercent([{ state: "alarm", level: "critical" }])).toBe(0);
  });

  it("区間が無い・一度も受信が無ければ null", () => {
    expect(uptimePercent([])).toBeNull();
    expect(uptimePercent([{ state: "none" }, { state: "none" }])).toBeNull();
  });

  it("最初の受信より前の区間は分母に含めない", () => {
    const cells: TimelineCell[] = [{ state: "none" }, { state: "none" }, { state: "running" }, { state: "none" }];
    expect(uptimePercent(cells)).toBe(50);
  });
});

describe("describeSegment・stateLabel", () => {
  const at = (h: number, m: number) => new Date(2024, 0, 1, h, m).getTime();
  const segment = (startMs: number, endMs: number) => ({
    state: "alarm" as const,
    level: "critical" as const,
    startMs,
    endMs,
    leftPercent: 0,
    widthPercent: 1,
  });

  it("「警報 11:42〜12:58（76 分）」の形で出す", () => {
    expect(describeSegment({ ...segment(at(11, 42), at(12, 58)), level: undefined })).toBe("警報 11:42〜12:58（76 分）");
  });

  it("警報は段階も出し、2 時間以上は「時間 分」にする", () => {
    expect(describeSegment(segment(at(8, 0), at(10, 30)))).toBe("警報（重故障） 08:00〜10:30（2 時間 30 分）");
  });

  it("状態の名前", () => {
    expect(stateLabel("none")).toBe("受信なし");
    expect(stateLabel("alarm", "warning")).toBe("警報（軽故障）");
    expect(stateLabel("running")).toBe("稼働");
  });
});

describe("短い欠けの引き継ぎ（fillShortGaps・buildTimelineCells）", () => {
  const FROM = Date.UTC(2024, 0, 1, 0, 0);
  const HOUR = 3_600_000;
  /** 60 秒ごとのハートビート（値 1）。skipFromS〜skipToS（秒）の受信は欠けたことにする */
  const heartbeats = (skipFromS = -1, skipToS = -1, lastS = 3599) =>
    Array.from({ length: Math.floor(lastS / 60) + 1 }, (_, i) => i * 60)
      .filter((t) => !(t >= skipFromS && t < skipToS))
      .map((t) => ({ start: new Date(FROM + t * 1000).toISOString(), min: 1, max: 1, count: 1 }));
  const states = (buckets: ReturnType<typeof heartbeats>, hours = 1, count = 144) =>
    buildTimelineCells(buckets, FROM, FROM + hours * HOUR, count, [], null).map((c) => c.state);

  it("60 秒周期のハートビートは、1 時間（区間 25 秒）でも縞にならない", () => {
    const cells = states(heartbeats());
    expect(cells.slice(0, 143).every((s) => s === "running")).toBe(true);
  });

  it("6 時間・24 時間・7 日でも縞にならない（区間が 60 秒より長ければ、そのまま稼働）", () => {
    for (const [hours, lastS] of [[6, 6 * 3600 - 1], [24, 24 * 3600 - 1]] as const) {
      expect(states(heartbeats(-1, -1, lastS), hours).every((s) => s === "running")).toBe(true);
    }
    const week = Array.from({ length: 7 * 24 * 60 }, (_, i) => ({ start: new Date(FROM + i * 60_000).toISOString(), min: 1, max: 1, count: 1 }));
    expect(states(week, 168).every((s) => s === "running")).toBe(true);
  });

  it("欠け 3 分（180 秒）は受信なしになり、その前後は稼働", () => {
    const cells = states(heartbeats(1200, 1380)); // 20:00〜23:00 の受信が無い
    const none = cells.filter((s) => s === "none").length;
    expect(none).toBeGreaterThanOrEqual(6); // 180 秒 ÷ 25 秒 = 約 7 区間
    expect(cells[0]).toBe("running");
    expect(cells[100]).toBe("running");
  });

  it("欠け 1 回分（2 分未満）は前の状態を引き継ぐ", () => {
    // 1 件抜けると受信の間隔は 120 秒。値の無い区間は 95 秒以下
    const cells = states(heartbeats(1200, 1260));
    expect(cells.slice(0, 143).every((s) => s === "running")).toBe(true);
  });

  it("先頭の欠けは受信なしのまま、末尾の短い欠けは引き継ぎ、長い欠けは受信なし", () => {
    const late = states(heartbeats().filter((b) => new Date(b.start).getTime() >= FROM + 1800_000));
    expect(late[0]).toBe("none");
    expect(late[70]).toBe("none");
    expect(late[75]).toBe("running");
    // 末尾: 最後の受信が 59 分 → 末尾の欠けは 60 秒（区間 2〜3 個）で引き継ぐ。50 分で止まると受信なし
    expect(states(heartbeats(-1, -1, 3000))[143]).toBe("none");
  });

  it("fillShortGaps: 区間の幅 × 個数が上限未満のときだけ埋める", () => {
    const run: TimelineCell = { state: "running" };
    const none: TimelineCell = { state: "none" };
    expect(fillShortGaps([run, none, none, run], 50_000).map((c) => c.state)).toEqual(["running", "running", "running", "running"]);
    expect(fillShortGaps([run, none, none, run], 60_000).map((c) => c.state)).toEqual(["running", "none", "none", "running"]);
    expect(fillShortGaps([none, none, run], 10_000).map((c) => c.state)).toEqual(["none", "none", "running"]);
  });
});
