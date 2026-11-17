import { describe, expect, it } from "vitest";

import type { Alarm, Reading, Sensor } from "../types";
import { buildStrips, countStates, formatAge, STALE_MS } from "./overview";

const NOW = new Date("2026-11-18T00:42:00Z").getTime();

function sensor(id: string, name: string, extra: Partial<Sensor> = {}): Sensor {
  return {
    id,
    name,
    ingestKey: id,
    unit: "℃",
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: null,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

const reading = (sensorId: string, value: number, agoMs = 10_000): Reading => ({
  sensorId,
  value,
  recordedAt: new Date(NOW - agoMs).toISOString(),
});

function alarm(sensorId: string, severity: Alarm["severity"], status: Alarm["status"] = "active"): Alarm {
  return {
    id: `${sensorId}-${severity}`,
    sensorId,
    triggeredAt: new Date(NOW).toISOString(),
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    value: 1,
    status,
    thresholdBreached: "max",
    severity,
  };
}

describe("buildStrips（全体監視の札）", () => {
  it("同じ機器のセンサーは 1 枚の札にまとめ、機器の無いセンサーは 1 つずつ", () => {
    const sensors = [
      sensor("t", "洋室 温度", { deviceId: "d1", deviceName: "env-youshitsu" }),
      sensor("h", "洋室 湿度", { deviceId: "d1", deviceName: "env-youshitsu" }),
      sensor("x", "単独"),
    ];
    const strips = buildStrips(sensors, [reading("t", 20), reading("h", 50), reading("x", 1)], [], NOW);
    expect(strips.map((s) => s.title).sort()).toEqual(["env-youshitsu", "単独"]);
    expect(strips.find((s) => s.title === "env-youshitsu")?.sensors).toHaveLength(2);
  });

  it("状態の重い順（警報 → 注意 → 正常 → 未受信）に並べる", () => {
    const sensors = [
      sensor("ok", "正常"),
      sensor("never", "まだ"),
      sensor("hot", "高い", { thresholdMaxCritical: 100 }),
      sensor("old", "止まった"),
    ];
    const latest = [reading("ok", 1), reading("hot", 120), reading("old", 1, STALE_MS + 1)];
    const strips = buildStrips(sensors, latest, [], NOW);
    expect(strips.map((s) => s.state)).toEqual(["critical", "warning", "normal", "never"]);
    expect(strips[1].reason).toBe("受信なし");
  });

  it("未解決のアラームがあれば、値が戻っていてもその重さ。解決済みは数えない", () => {
    const sensors = [sensor("a", "A"), sensor("b", "B")];
    const strips = buildStrips(sensors, [reading("a", 1), reading("b", 1)], [alarm("a", "warning"), alarm("b", "critical", "resolved")], NOW);
    expect(strips.find((s) => s.title === "A")?.state).toBe("warning");
    expect(strips.find((s) => s.title === "B")?.state).toBe("normal");
  });

  it("状態ごとの数", () => {
    const strips = buildStrips([sensor("a", "A"), sensor("b", "B")], [reading("a", 1)], [], NOW);
    expect(countStates(strips)).toEqual({ critical: 0, warning: 0, normal: 1, never: 1 });
  });
});

describe("formatAge", () => {
  it("秒・分・時間・日", () => {
    expect(formatAge(12_000)).toBe("12 秒前");
    expect(formatAge(5 * 60_000)).toBe("5 分前");
    expect(formatAge(3 * 3_600_000)).toBe("3 時間前");
    expect(formatAge(3 * 86_400_000)).toBe("3 日前");
  });
});
