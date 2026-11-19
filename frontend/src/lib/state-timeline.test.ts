import { describe, expect, it } from "vitest";

import {
  bucketCell,
  buildSegments,
  buildTimelineCells,
  describeSegment,
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

  it("開始時刻で区間に入れ、データの無い区間は受信なし", () => {
    const cells = buildTimelineCells([bucketAt(0, 1, 1), bucketAt(2, 1, 1)], FROM, TO, 10, [], null);
    expect(cells.map((c) => c.state)).toEqual([
      "running", "none", "running", "none", "none", "none", "none", "none", "none", "none",
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

  it("区間が無ければ null", () => {
    expect(uptimePercent([])).toBeNull();
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
