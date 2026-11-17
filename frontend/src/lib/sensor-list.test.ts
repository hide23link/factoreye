import { describe, expect, it } from "vitest";

import type { Reading, Sensor } from "../types";
import { STALE_MS } from "./overview";
import { filterCounts, groupByDevice, hasLimits, matchesFilter, matchesQuery, sensorLive } from "./sensor-list";

const NOW = new Date("2026-11-18T00:00:00Z").getTime();

function sensor(id: string, name: string, extra: Partial<Sensor> = {}): Sensor {
  return {
    id,
    name,
    ingestKey: `key-${id}`,
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

const reading = (sensorId: string, value: number, agoMs: number): Reading => ({ sensorId, value, recordedAt: new Date(NOW - agoMs).toISOString() });

describe("sensorLive（受信の状態）", () => {
  it("15 分以内は受信中、超えたら止まっている、受信が無ければ未受信", () => {
    expect(sensorLive(sensor("a", "A"), reading("a", 1, STALE_MS), NOW).state).toBe("receiving");
    expect(sensorLive(sensor("a", "A"), reading("a", 1, STALE_MS + 1000), NOW).state).toBe("stopped");
    expect(sensorLive(sensor("a", "A"), undefined, NOW)).toMatchObject({ state: "never", ageMs: null });
  });
  it("値がしきい値の外なら、その段階を返す", () => {
    expect(sensorLive(sensor("a", "A", { thresholdMaxCritical: 10 }), reading("a", 12, 1000), NOW).level).toBe("critical");
  });
});

describe("検索と絞り込み", () => {
  const s = sensor("a", "洋室 CO2", { deviceName: "env-youshitsu", thresholdMaxWarning: 900 });
  it("名前・キー・機器名に、空白区切りの全部の語が含まれれば一致（大小文字は区別しない）", () => {
    expect(matchesQuery(s, "co2 ENV")).toBe(true);
    expect(matchesQuery(s, "key-a")).toBe(true);
    expect(matchesQuery(s, "温度")).toBe(false);
    expect(matchesQuery(s, "  ")).toBe(true);
  });
  it("しきい値の有無", () => {
    expect(hasLimits(s)).toBe(true);
    expect(hasLimits(sensor("b", "B"))).toBe(false);
  });
  it("「止まっている」は、受信が古いものと、まだ無いものの両方", () => {
    const stopped = sensorLive(s, reading("a", 1, STALE_MS + 1000), NOW);
    const never = sensorLive(s, undefined, NOW);
    expect(matchesFilter("stopped", s, stopped)).toBe(true);
    expect(matchesFilter("stopped", s, never)).toBe(true);
    expect(matchesFilter("receiving", s, stopped)).toBe(false);
  });
  it("ボタンごとの件数は、検索の文字を反映する", () => {
    const sensors = [sensor("a", "洋室 温度"), sensor("b", "洋室 CO2", { thresholdMaxCritical: 1000 }), sensor("c", "寝室 温度")];
    const lives = new Map(sensors.map((x, i) => [x.id, sensorLive(x, i === 2 ? undefined : reading(x.id, 1, 1000), NOW)]));
    expect(filterCounts(sensors, lives, "")).toEqual({ all: 3, receiving: 2, stopped: 1, limits: 1 });
    expect(filterCounts(sensors, lives, "洋室")).toEqual({ all: 2, receiving: 2, stopped: 0, limits: 1 });
  });
});

describe("groupByDevice", () => {
  it("機器は名前順、機器なしは最後。機器に属するセンサーはまとめる", () => {
    const groups = groupByDevice([
      sensor("1", "x"),
      sensor("2", "温度", { deviceId: "d2", deviceName: "env-b" }),
      sensor("3", "湿度", { deviceId: "d1", deviceName: "env-a" }),
      sensor("4", "CO2", { deviceId: "d2", deviceName: "env-b" }),
    ]);
    expect(groups.map((g) => g.title)).toEqual(["env-a", "env-b", "機器なし"]);
    expect(groups[1].sensors.map((x) => x.name)).toEqual(["温度", "CO2"]);
  });
});
