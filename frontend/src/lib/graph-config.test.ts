import { describe, expect, it } from "vitest";

import type { Widget } from "../types";
import { DEFAULT_RANGE } from "./timeRange";
import {
  GRAPH_COLORS,
  effectiveBounds,
  effectiveRange,
  graphColor,
  graphSensorIds,
  graphSensorPatch,
  nextGraphColor,
  graphYDomain,
  thresholdLines,
} from "./graph-config";

type W = Pick<Widget, "type" | "sensorId" | "config">;
const graph = (sensorId: string | null, config: W["config"] = {}): W => ({ type: "SensorGraph", sensorId, config });

describe("graphSensorIds", () => {
  it("古いセンサーグラフは sensorId だけ", () => {
    expect(graphSensorIds(graph("a"))).toEqual(["a"]);
  });
  it("config.sensorIds があればそれを使う", () => {
    expect(graphSensorIds(graph("a", { sensorIds: ["a", "b"] }))).toEqual(["a", "b"]);
  });
  it("複数センサー比較は sensorId を見ない", () => {
    expect(graphSensorIds({ type: "MultiSensorComparison", sensorId: "x", config: { sensorIds: ["a"] } })).toEqual(["a"]);
  });
  it("センサー無し", () => {
    expect(graphSensorIds(graph(null))).toEqual([]);
  });
});

describe("graphColor", () => {
  it("選んだ色を優先する", () => {
    expect(graphColor(graph("a", { colors: ["#111111"] }), 0)).toBe("#111111");
  });
  it("従来の単色（color）を先頭の線に使う", () => {
    expect(graphColor(graph("a", { color: "#dc2626" }), 0)).toBe("#dc2626");
    expect(graphColor(graph("a", { color: "#dc2626" }), 1)).toBe(GRAPH_COLORS[1]);
  });
  it("複数センサー比較は従来の並びの色", () => {
    expect(graphColor({ type: "MultiSensorComparison", config: {} }, 1)).toBe("#dc2626");
  });
  it("次の色は一周して戻る", () => {
    expect(nextGraphColor(GRAPH_COLORS[0])).toBe(GRAPH_COLORS[1]);
    expect(nextGraphColor(GRAPH_COLORS[GRAPH_COLORS.length - 1])).toBe(GRAPH_COLORS[0]);
    expect(nextGraphColor("#abcdef")).toBe(GRAPH_COLORS[0]);
  });
});

describe("graphSensorPatch", () => {
  it("センサーを外しても、残った線の色が入れ替わらない", () => {
    const widget = graph("a", { sensorIds: ["a", "b", "c"], colors: ["#111111", "#222222", "#333333"] });
    const patch = graphSensorPatch(widget, ["a", "c"], [0, 2]);
    expect(patch.sensorId).toBe("a");
    expect(patch.config.sensorIds).toEqual(["a", "c"]);
    expect(patch.config.colors).toEqual(["#111111", "#333333"]);
  });
  it("追加したセンサーには既定の色", () => {
    const patch = graphSensorPatch(graph("a"), ["a", "b"], [0]);
    expect(patch.config.colors).toEqual([GRAPH_COLORS[0], GRAPH_COLORS[1]]);
  });
  it("複数センサー比較の sensorId は null のまま", () => {
    const patch = graphSensorPatch({ type: "MultiSensorComparison", config: {} }, ["a"], [0]);
    expect(patch.sensorId).toBeNull();
  });
});

describe("effectiveRange", () => {
  it("固有の期間が無ければダッシュボード全体", () => {
    expect(effectiveRange({ config: {} }, DEFAULT_RANGE)).toBe(DEFAULT_RANGE);
  });
  it("固有の期間があれば、直近 N 時間", () => {
    expect(effectiveBounds({ config: { rangeHours: 6 } }, DEFAULT_RANGE, 7 * 3600_000)).toEqual({
      from: 3600_000,
      to: 7 * 3600_000,
    });
  });
});

describe("thresholdLines / graphYDomain", () => {
  const sensor = {
    thresholdMaxWarning: 190,
    thresholdMaxCritical: 195,
    thresholdMinWarning: null,
    thresholdMinCritical: null,
  };

  it("設定されているしきい値だけを線にする", () => {
    expect(thresholdLines(sensor).map((l) => [l.value, l.severity])).toEqual([
      [190, "warning"],
      [195, "critical"],
    ]);
  });

  it("縦軸が自動のとき、しきい値が範囲に入るよう広げる", () => {
    const [min, max] = graphYDomain({}, [190, 195]);
    expect(typeof min).toBe("function");
    expect(typeof max).toBe("function");
    // データが 180〜185 でも、上は 195 まで見える。下はデータのまま
    expect((min as (v: number) => number)(180)).toBe(180);
    expect((max as (v: number) => number)(185)).toBe(195);
    expect((max as (v: number) => number)(200)).toBe(200);
  });

  it("手動で決めた値を優先する。しきい値が無ければ自動", () => {
    expect(graphYDomain({ yAxisMin: 0, yAxisMax: 100 }, [190])).toEqual([0, 100]);
    expect(graphYDomain({}, [])).toEqual(["auto", "auto"]);
  });
});
