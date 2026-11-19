import { describe, expect, it } from "vitest";

import type { Sensor, Widget } from "../types";
import { GRAPH_COLORS } from "./graph-config";
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

describe("assignSensor（計器グラフ）", () => {
  it("行を足す。同じセンサーは重ねない。入れ替えはそのセンサーだけ", () => {
    const added = assignSensor(widget("TrendStack", "a", { sensorIds: ["a"] }), sensor("b", "B"), "add");
    expect(added).toMatchObject({ ok: true, sensorId: "a", config: { sensorIds: ["a", "b"] } });
    expect(assignSensor(widget("TrendStack", "a", { sensorIds: ["a"] }), sensor("a", "A"), "add").ok).toBe(false);
    const replaced = assignSensor(widget("TrendStack", "a", { sensorIds: ["a", "b"] }), sensor("c", "C"), "replace");
    expect(replaced).toMatchObject({ ok: true, sensorId: "c", config: { sensorIds: ["c"] } });
  });
});

describe("assignSensor（計器グラフ）の線の色", () => {
  it("行を足しても、変えた色は保たれ、足した行は既定の色になる", () => {
    const w = widget("TrendStack", "a", { sensorIds: ["a", "b"], colors: ["#111111", "#222222"] });
    const added = assignSensor(w, sensor("c", "C"), "add");
    expect(added).toMatchObject({ ok: true, config: { colors: ["#111111", "#222222", GRAPH_COLORS[2]] } });
  });
  it("入れ替えは、新しい 1 行だけで、既定の色になる", () => {
    const w = widget("TrendStack", "a", { sensorIds: ["a", "b"], colors: ["#111111", "#222222"] });
    expect(assignSensor(w, sensor("c", "C"), "replace")).toMatchObject({ ok: true, config: { colors: [GRAPH_COLORS[0]] } });
  });
});

describe("assignSensor（状態の帯）", () => {
  it("追加は行を足し、入れ替えは残るセンサーの停止とみなす値だけ残す", () => {
    const w = widget("StateTimeline", "a", { sensorIds: ["a", "b"], stateStopValues: { a: 0, b: 5 } });
    const added = assignSensor(w, sensor("c", "C"), "add");
    expect(added.ok && added.config.sensorIds).toEqual(["a", "b", "c"]);
    const replaced = assignSensor(w, sensor("b", "B"), "replace");
    expect(replaced.ok && replaced.config.sensorIds).toEqual(["b"]);
    expect(replaced.ok && replaced.config.stateStopValues).toEqual({ b: 5 });
    expect(assignSensor(w, sensor("a", "A"), "add").ok).toBe(false);
  });
});
