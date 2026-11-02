import { describe, expect, it } from "vitest";

import type { Sensor, Widget } from "../types";
import { acceptsSensor, assignSensor } from "./widget-sensors";

function sensor(id: string, name: string, unit = "℃"): Sensor {
  return {
    id,
    name,
    ingestKey: id,
    unit,
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: null,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "",
    updatedAt: "",
  };
}

function widget(type: Widget["type"], sensorId: string | null = null, config: Widget["config"] = {}): Widget {
  return { id: "w", dashboardId: "d", sensorId, type, gridColumn: 1, gridRow: 1, gridWidth: 4, gridHeight: 4, config, createdAt: "", updatedAt: "" };
}

describe("assignSensor", () => {
  it("グラフへ追加すると、sensorIds に足され、先頭が sensorId になる", () => {
    const result = assignSensor(widget("SensorGraph", "a"), sensor("b", "B"), "add");
    expect(result).toMatchObject({ ok: true, sensorId: "a", config: { sensorIds: ["a", "b"] } });
  });

  it("空のグラフに最初のセンサーを追加すると、そのセンサーが先頭", () => {
    const result = assignSensor(widget("SensorGraph"), sensor("a", "A"), "add");
    expect(result).toMatchObject({ ok: true, sensorId: "a", config: { sensorIds: ["a"] } });
  });

  it("グラフに同じセンサーを重ねて追加しない", () => {
    expect(assignSensor(widget("SensorGraph", "a"), sensor("a", "A"), "add").ok).toBe(false);
  });

  it("入れ替えは、そのセンサー1つだけにする", () => {
    const result = assignSensor(widget("SensorGraph", "a", { sensorIds: ["a", "b"] }), sensor("c", "C"), "replace");
    expect(result).toMatchObject({ ok: true, sensorId: "c", config: { sensorIds: ["c"] } });
  });

  it("数値は入れ替え", () => {
    expect(assignSensor(widget("StatValue", "a"), sensor("b", "B"), "add")).toMatchObject({ ok: true, sensorId: "b" });
  });

  it("生産管理に生産数らしいセンサーなら注意なし、そうでなければ注意つき", () => {
    const good = assignSensor(widget("ProductionPlan"), sensor("p", "ライン1 生産数", "個"), "replace");
    const odd = assignSensor(widget("ProductionPlan"), sensor("t", "温度"), "replace");
    expect(good.ok && good.message).not.toContain("確認してください");
    expect(odd.ok && odd.message).toContain("確認してください");
  });

  it("アラーム一覧にはセンサーを割り当てられない", () => {
    expect(assignSensor(widget("AlarmAlert"), sensor("a", "A"), "add").ok).toBe(false);
    expect(acceptsSensor(widget("AlarmAlert"))).toBe(false);
    expect(acceptsSensor(widget("SensorGraph"))).toBe(true);
  });
});

describe("assignSensor（達成ストリップ）", () => {
  it("追加すると sensorIds に足される。すでにあれば何もしない", () => {
    const first = assignSensor(widget("TargetStrip"), sensor("a", "atom01-heartbeat", ""), "add");
    expect(first).toMatchObject({ ok: true, sensorId: "a", config: { sensorIds: ["a"] } });

    const withA = widget("TargetStrip", "a", { sensorIds: ["a"] });
    const second = assignSensor(withA, sensor("b", "atom02-heartbeat", ""), "add");
    expect(second).toMatchObject({ ok: true, config: { sensorIds: ["a", "b"] } });

    const dup = assignSensor(withA, sensor("a", "atom01-heartbeat", ""), "add");
    expect(dup.ok).toBe(false);
  });

  it("入れ替えは、そのセンサーだけにする", () => {
    const w = widget("TargetStrip", "a", { sensorIds: ["a", "b"] });
    const result = assignSensor(w, sensor("c", "atom03-heartbeat", ""), "replace");
    expect(result).toMatchObject({ ok: true, sensorId: "c", config: { sensorIds: ["c"] } });
  });
});
