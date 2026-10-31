import { describe, expect, it } from "vitest";

import type { Widget } from "../types";
import { DEFAULT_RANGE } from "./timeRange";
import {
  GRAPH_COLORS,
  effectiveBounds,
  effectiveRange,
  graphAxisSides,
  graphColor,
  graphSensorIds,
  graphSensorPatch,
  nextGraphColor,
  bandEnds,
  graphDataOptions,
  graphStyle,
  graphYAxisPlan,
  graphYDomain,
  thresholdBands,
  thresholdLines,
  thresholdMode,
  thresholdOverlay,
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

describe("graphStyle（見た目の読み方）", () => {
  it("何も指定していない古い設定は、従来の見た目（線はなめらか・面は直線、太さ1、塗り0.2、グリッド・ツールチップあり、凡例は下）", () => {
    expect(graphStyle({})).toEqual({
      curveType: "monotone",
      lineWidth: 1,
      fillOpacity: 0.2,
      showPoints: false,
      showGrid: true,
      showTooltip: true,
      legendPosition: "bottom",
    });
    expect(graphStyle({ graphType: "area" }).curveType).toBe("linear");
  });

  it("線の形を選ぶと、recharts の曲線の種類になる", () => {
    expect(graphStyle({ lineShape: "linear" }).curveType).toBe("linear");
    expect(graphStyle({ lineShape: "step" }).curveType).toBe("stepAfter");
    expect(graphStyle({ lineShape: "smooth", graphType: "area" }).curveType).toBe("monotone");
  });

  it("太さ・塗りは範囲に丸め、数値でない値や未知の文字列は既定に戻す", () => {
    expect(graphStyle({ lineWidth: 99 }).lineWidth).toBe(6);
    expect(graphStyle({ lineWidth: -3 }).lineWidth).toBe(0.5);
    expect(graphStyle({ lineWidth: Number.NaN }).lineWidth).toBe(1);
    expect(graphStyle({ fillOpacity: 5 }).fillOpacity).toBe(1);
    expect(graphStyle({ lineShape: "zigzag" as never }).curveType).toBe("monotone");
    expect(graphStyle({ legendPosition: "top" as never }).legendPosition).toBe("bottom");
  });

  it("オフにした項目だけ変わる", () => {
    expect(graphStyle({ showGrid: false, showTooltip: false, showPoints: true, legendPosition: "right" })).toMatchObject({
      showGrid: false,
      showTooltip: false,
      showPoints: true,
      legendPosition: "right",
    });
  });
});

describe("thresholdMode", () => {
  it("thresholdMode が無ければ、従来の showThresholds に従う（true は線）", () => {
    expect(thresholdMode({})).toBe("off");
    expect(thresholdMode({ showThresholds: true })).toBe("line");
  });
  it("thresholdMode があれば、それを優先する（showThresholds が残っていても）", () => {
    expect(thresholdMode({ showThresholds: true, thresholdMode: "off" })).toBe("off");
    expect(thresholdMode({ thresholdMode: "both" })).toBe("both");
  });
  it("未知の値は、showThresholds に戻る", () => {
    expect(thresholdMode({ thresholdMode: "bad" as never, showThresholds: true })).toBe("line");
  });
});

describe("thresholdBands", () => {
  const none = { thresholdMaxWarning: null, thresholdMaxCritical: null, thresholdMinWarning: null, thresholdMinCritical: null };
  it("しきい値が無ければ帯も無い", () => {
    expect(thresholdBands(none)).toEqual([]);
  });
  it("上限: 軽故障は 軽故障〜重故障、重故障は 重故障〜上（端なし）", () => {
    const bands = thresholdBands({ ...none, thresholdMaxWarning: 80, thresholdMaxCritical: 90 });
    expect(bands).toEqual([
      { from: 80, to: 90, severity: "warning" },
      { from: 90, to: null, severity: "critical" },
    ]);
  });
  it("下限も同様に、下へ向かう。重故障だけのときは重故障の帯だけ", () => {
    expect(thresholdBands({ ...none, thresholdMinWarning: 10, thresholdMinCritical: 5 })).toEqual([
      { from: 5, to: 10, severity: "warning" },
      { from: null, to: 5, severity: "critical" },
    ]);
    expect(thresholdBands({ ...none, thresholdMaxCritical: 90 })).toEqual([{ from: 90, to: null, severity: "critical" }]);
  });
  it("軽故障だけのときは、上（端なし）まで軽故障の色", () => {
    expect(thresholdBands({ ...none, thresholdMaxWarning: 80 })).toEqual([{ from: 80, to: null, severity: "warning" }]);
  });
});

describe("thresholdOverlay", () => {
  const sensor = { thresholdMaxWarning: 80, thresholdMaxCritical: 90, thresholdMinWarning: null, thresholdMinCritical: null };
  it("表示しない／センサーが無いときは、何も重ねず、縦軸も広げない", () => {
    expect(thresholdOverlay({}, sensor)).toEqual({ axisValues: [], lines: [], bands: [] });
    expect(thresholdOverlay({ thresholdMode: "line" }, undefined)).toEqual({ axisValues: [], lines: [], bands: [] });
  });
  it("線だけ・帯だけ・両方で、重ねるものが変わる。縦軸はどれでも広げる", () => {
    const line = thresholdOverlay({ thresholdMode: "line" }, sensor);
    expect(line.lines).toHaveLength(2);
    expect(line.bands).toEqual([]);
    expect(line.axisValues).toEqual([80, 90]);

    const area = thresholdOverlay({ thresholdMode: "area" }, sensor);
    expect(area.lines).toEqual([]);
    expect(area.bands).toHaveLength(2);
    expect(area.axisValues).toEqual([80, 90]);

    const both = thresholdOverlay({ thresholdMode: "both" }, sensor);
    expect(both.lines).toHaveLength(2);
    expect(both.bands).toHaveLength(2);
  });
  it("古い showThresholds: true は線", () => {
    expect(thresholdOverlay({ showThresholds: true }, sensor).lines).toHaveLength(2);
  });
});

describe("graphDataOptions", () => {
  it("何も指定していない古い設定は、平均・30秒・実際の値・積み上げなし", () => {
    expect(graphDataOptions({}, 1)).toEqual({ aggregation: "avg", refreshMs: 30_000, axisMode: "shared", stack: "none", stackable: false });
  });
  it("区間の値と更新間隔を選べる。選択肢にない間隔・未知の値は既定に戻す", () => {
    expect(graphDataOptions({ aggregation: "max", refreshSeconds: 10 }, 1)).toMatchObject({ aggregation: "max", refreshMs: 10_000 });
    expect(graphDataOptions({ refreshSeconds: 7 }, 1).refreshMs).toBe(30_000);
    expect(graphDataOptions({ refreshSeconds: 0 }, 1).refreshMs).toBe(30_000);
    expect(graphDataOptions({ aggregation: "median" as never }, 1).aggregation).toBe("avg");
  });
  it("0〜100% と積み上げは、センサー2つ以上のときだけ効く", () => {
    expect(graphDataOptions({ axisMode: "normalized" }, 1).axisMode).toBe("shared");
    expect(graphDataOptions({ axisMode: "normalized" }, 2).axisMode).toBe("normalized");
    expect(graphDataOptions({ graphType: "area", stack: "normal" }, 1).stack).toBe("none");
    expect(graphDataOptions({ graphType: "area", stack: "normal" }, 2).stack).toBe("normal");
  });
  it("積み上げは、面・棒で、縦軸が実際の値のときだけ効く（線グラフ・0〜100% では無効）", () => {
    expect(graphDataOptions({ graphType: "line", stack: "normal" }, 2).stack).toBe("none");
    expect(graphDataOptions({ stack: "normal" }, 2).stack).toBe("none");
    expect(graphDataOptions({ graphType: "bar", stack: "percent" }, 2).stack).toBe("percent");
    expect(graphDataOptions({ graphType: "area", stack: "normal", axisMode: "normalized" }, 2).stack).toBe("none");
  });
});

describe("graphYAxisPlan", () => {
  it("実際の値: 手動の範囲、無ければしきい値込みの自動", () => {
    const plan = graphYAxisPlan({ yAxisMin: 0, yAxisMax: 100 }, graphDataOptions({}, 2), []);
    expect(plan).toEqual({ domain: [0, 100], scale: "values" });
  });
  it("0〜100% にそろえるときは 0〜100。手動の縦軸は使わない", () => {
    const plan = graphYAxisPlan({ axisMode: "normalized", yAxisMin: 5, yAxisMax: 6 }, graphDataOptions({ axisMode: "normalized" }, 2), []);
    expect(plan).toEqual({ domain: [0, 100], scale: "percent" });
  });
  it("100% 積み上げは 0〜1（recharts の換算後）", () => {
    const options = graphDataOptions({ graphType: "area", stack: "percent" }, 2);
    expect(graphYAxisPlan({}, options, [])).toEqual({ domain: [0, 1], scale: "percentStack" });
  });
});

describe("graphDataOptions: stackable", () => {
  it("積み上げを選べるのは、センサー2つ以上の面・棒で、実際の値の縦軸のとき", () => {
    expect(graphDataOptions({ graphType: "area" }, 2).stackable).toBe(true);
    expect(graphDataOptions({ graphType: "bar" }, 2).stackable).toBe(true);
    expect(graphDataOptions({ graphType: "line" }, 2).stackable).toBe(false);
    expect(graphDataOptions({ graphType: "area" }, 1).stackable).toBe(false);
    expect(graphDataOptions({ graphType: "area", axisMode: "normalized" }, 2).stackable).toBe(false);
  });
});

describe("bandEnds", () => {
  it("手動の縦軸が無ければ、データとしきい値の最小〜最大から、少し外へ余らせる", () => {
    expect(bandEnds({}, [70, 92], [80, 90])).toEqual({ low: 70 - 0.44, high: 92 + 0.44 });
  });
  it("手動の縦軸があれば、その範囲を使う", () => {
    const ends = bandEnds({ yAxisMin: 0, yAxisMax: 100 }, [70, 92], [80, 90]);
    expect(ends.low).toBeCloseTo(-2);
    expect(ends.high).toBeCloseTo(102);
  });
  it("データもしきい値も無いときは、0〜1。値がすべて同じでも幅を持たせる", () => {
    expect(bandEnds({}, [], [])).toEqual({ low: 0, high: 1 });
    expect(bandEnds({}, [5, 5], [5])).toEqual({ low: 4, high: 6 });
  });
});

describe("graphAxisSides（縦軸の左右）", () => {
  const units: Record<string, string> = { a: "V", b: "V", c: "A", d: "℃" };
  const unitOf = (id: string) => units[id];

  it("単位が同じセンサーは同じ軸（1種類なら右の軸は使わない）", () => {
    const r = graphAxisSides({}, ["a", "b"], unitOf);
    expect(r.sides).toEqual({ a: "left", b: "left" });
    expect(r.dual).toBe(false);
    expect(r.leftUnit).toBe("V");
  });

  it("単位が2種類なら、最初の単位を左、次の単位を右にする", () => {
    const r = graphAxisSides({}, ["a", "c", "b"], unitOf);
    expect(r.sides).toEqual({ a: "left", c: "right", b: "left" });
    expect(r.dual).toBe(true);
    expect(r.leftUnit).toBe("V");
    expect(r.rightUnit).toBe("A");
  });

  it("3種類目以降の単位は、既定では左", () => {
    const r = graphAxisSides({}, ["c", "a", "d"], unitOf);
    expect(r.sides).toEqual({ c: "left", a: "right", d: "left" });
    expect(r.leftUnit).toBe("A / ℃");
    expect(r.rightUnit).toBe("V");
  });

  it("設定で選んだ左右は既定より優先する（不正な値は無視）", () => {
    const config = { axisSides: { a: "right", c: "left", b: "bogus" } } as unknown as Parameters<typeof graphAxisSides>[0];
    const r = graphAxisSides(config, ["a", "b", "c"], unitOf);
    expect(r.sides).toEqual({ a: "right", b: "left", c: "left" });
    expect(r.dual).toBe(true);
    expect(r.leftUnit).toBe("V / A");
    expect(r.rightUnit).toBe("V");
  });

  it("単位が不明のセンサーは空の単位として扱い、軸の単位には出さない", () => {
    const r = graphAxisSides({}, ["x", "a"], () => undefined);
    expect(r.sides).toEqual({ x: "left", a: "left" });
    expect(r.leftUnit).toBe("");
  });
});

describe("graphAxisSides の単位の入力（axisUnits）", () => {
  const units: Record<string, string> = { a: "V", c: "A" };
  const unitOf = (id: string) => units[id];

  it("入力した単位は、自動の単位より優先する。空欄（空白だけ）は自動に戻る", () => {
    const config = { axisUnits: { left: " 電圧[V] ", right: "  " } };
    const r = graphAxisSides(config, ["a", "c"], unitOf);
    expect(r.leftUnit).toBe("電圧[V]");
    expect(r.rightUnit).toBe("A");
  });

  it("一軸のときも、入力した単位を左の軸に使う", () => {
    const r = graphAxisSides({ axisUnits: { left: "kW" } }, ["a"], unitOf);
    expect(r.dual).toBe(false);
    expect(r.leftUnit).toBe("kW");
  });
});
