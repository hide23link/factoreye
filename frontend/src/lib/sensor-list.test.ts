import { describe, expect, it } from "vitest";

import type { Reading, Sensor } from "../types";
import { STALE_MS } from "./overview";
import { filterCounts, groupByDevice, hasLimits, formatLiveValue, hourRange, matchesFilter, matchesQuery, sensorLive, sensorStatus, sparkPoints, thresholdSummary } from "./sensor-list";

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
    expect(filterCounts(sensors, lives, "")).toEqual({ all: 3, receiving: 2, stopped: 1, outside: 0 });
    expect(filterCounts(sensors, lives, "洋室")).toEqual({ all: 2, receiving: 2, stopped: 0, outside: 0 });
  });
  it("「しきい値の外」は、受信中で今の値がしきい値の外のもの（止まっているものは数えない）", () => {
    const s2 = sensor("a", "洋室 CO2", { thresholdMaxCritical: 1000 });
    expect(matchesFilter("outside", s2, sensorLive(s2, reading("a", 1052, 1000), NOW))).toBe(true);
    expect(matchesFilter("outside", s2, sensorLive(s2, reading("a", 900, 1000), NOW))).toBe(false);
    expect(matchesFilter("outside", s2, sensorLive(s2, reading("a", 1052, STALE_MS + 1000), NOW))).toBe(false);
  });
});

describe("一覧の状態・しきい値・直近 1 時間", () => {
  it("状態: 無効 > 未受信 > 止まっている > しきい値の外 > 正常の順に決める", () => {
    const s = sensor("a", "A", { thresholdMaxCritical: 10 });
    expect(sensorStatus(s, sensorLive(s, reading("a", 5, 1000), NOW))).toBe("normal");
    expect(sensorStatus(s, sensorLive(s, reading("a", 12, 1000), NOW))).toBe("outside");
    expect(sensorStatus(s, sensorLive(s, reading("a", 12, STALE_MS + 1000), NOW))).toBe("stopped");
    expect(sensorStatus(s, sensorLive(s, undefined, NOW))).toBe("never");
    const off = { ...s, enabled: false };
    expect(sensorStatus(off, sensorLive(off, reading("a", 5, 1000), NOW))).toBe("disabled");
  });
  it("しきい値の文字: 上限だけ「≤」、下限だけ「≥」、両方「—」でつなぐ、無ければ「—」。軽故障を優先し、無ければ重故障", () => {
    expect(thresholdSummary(sensor("a", "A", { thresholdMaxCritical: 1000 }))).toBe("≤ 1000");
    expect(thresholdSummary(sensor("a", "A", { thresholdMinCritical: 18 }))).toBe("≥ 18");
    expect(thresholdSummary(sensor("a", "A", { thresholdMinWarning: 18, thresholdMaxWarning: 28, thresholdMaxCritical: 35 }))).toBe("18 — 28");
    expect(thresholdSummary(sensor("a", "A"))).toBe("—");
  });
  it("直近 1 時間の最低〜最高は、区間の min・max から。データが無ければ null", () => {
    expect(hourRange([])).toBeNull();
    expect(hourRange([{ avg: 5, max: 6, min: 4 }, { avg: 7, max: 9, min: 6 }])).toEqual({ min: 4, max: 9 });
  });
  it("今の値の文字: 100 以上は整数、それ未満は小数 2 桁まで", () => {
    expect(formatLiveValue(1092.4)).toBe("1092");
    expect(formatLiveValue(22.1)).toBe("22.1");
    expect(formatLiveValue(22.456)).toBe("22.46");
    expect(formatLiveValue(-62)).toBe("-62");
  });
  it("小さな折れ線: 最低〜最高を高さいっぱいに。同じ値は真ん中、点が 1 つなら空", () => {
    expect(sparkPoints([1, 3, 2], 100, 20)).toBe("0.0,20.0 50.0,0.0 100.0,10.0");
    expect(sparkPoints([5, 5], 100, 20)).toBe("0.0,10.0 100.0,10.0");
    expect(sparkPoints([5], 100, 20)).toBe("");
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
