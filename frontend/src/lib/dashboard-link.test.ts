import { describe, expect, it } from "vitest";

import type { Widget, WidgetType } from "../types";
import type { Sensor } from "../types";
import { GRAPH_MIN_HEIGHT_PX, valueTiles, graphHeightCss, isSmallListWidget, listHeightCss, listWidgets } from "./dashboard-link";

function widget(id: string, type: WidgetType, gridRow: number, gridColumn: number): Widget {
  return {
    id,
    dashboardId: "d1",
    sensorId: "s1",
    type,
    gridColumn,
    gridRow,
    gridWidth: 6,
    gridHeight: 6,
    config: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("listWidgets", () => {
  it("置いた位置の順（上の段から、同じ段なら左から）に並べる。サーバーが返した順にはしない", () => {
    const widgets = [widget("c", "SensorGraph", 7, 1), widget("b", "StatValue", 1, 7), widget("a", "Gauge", 1, 1), widget("d", "MultiSensorComparison", 7, 7)];
    expect(listWidgets(widgets).map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
  });

  it.each<WidgetType>([
    "FloorPlan", "DeviceTree", "TrendStack", "StateTimeline", "TargetStrip", "ProductionPlan",
    "SensorGraph", "MultiSensorComparison", "StatValue", "Gauge", "TapeGauge", "ProductionStatus", "AlarmAlert",
  ])("%s も一覧に出す（除外する種類は無い）", (type) => {
    expect(listWidgets([widget("x", type, 1, 1)]).map((w) => w.id)).toEqual(["x"]);
  });
});

describe("小さい部品", () => {
  it("数値・メーター・計器・稼働ステータスは小さい部品（縦向きで 2 列）。グラフ・警報・ほかは違う", () => {
    expect((["StatValue", "Gauge", "TapeGauge", "ProductionStatus"] as const).every((type) => isSmallListWidget({ type }))).toBe(true);
    for (const type of ["SensorGraph", "AlarmAlert", "TrendStack", "FloorPlan"] as const) expect(isSmallListWidget({ type })).toBe(false);
  });
});

describe("カードの高さ", () => {
  it("半分は「帯と余白を引いた表示領域の 1/2」、全画面は「引いた残りいっぱい」。どちらも最低 240px", () => {
    expect(graphHeightCss("half", "--hdr")).toBe(`max(${GRAPH_MIN_HEIGHT_PX}px, calc((100dvh - var(--hdr) - 1.5rem) / 2))`);
    expect(graphHeightCss("full", "--hdr")).toBe(`max(${GRAPH_MIN_HEIGHT_PX}px, calc(100dvh - var(--hdr) - 1.5rem))`);
  });

  it("グラフは大きさの選択に従い、見本は固定の小さい高さ。グラフ以外は大きさの選択に従わない", () => {
    expect(listHeightCss(widget("g", "SensorGraph", 1, 1), "full", "--hdr", false)).toBe(graphHeightCss("full", "--hdr"));
    expect(listHeightCss(widget("m", "MultiSensorComparison", 1, 1), "half", "--hdr", false)).toBe(graphHeightCss("half", "--hdr"));
    expect(listHeightCss(widget("g", "SensorGraph", 1, 1), "full", "--hdr", true)).toBe("220px");
    expect(listHeightCss(widget("s", "StatValue", 1, 1), "full", "--hdr", false)).toBe("120px");
    expect(listHeightCss(widget("f", "FloorPlan", 1, 1), "full", "--hdr", false)).toBe(listHeightCss(widget("f", "FloorPlan", 1, 1), "half", "--hdr", false));
  });

  it("達成ストリップは、センサーの数に合わせた高さ（既定の 320px の空白を作らない）", () => {
    const strip = (ids: string[]) => ({ ...widget("t", "TargetStrip", 1, 1), config: { sensorIds: ids } });
    expect(listHeightCss(strip(["a", "b"]), "half", "--hdr", false)).toBe("229px");
    expect(listHeightCss(strip(["a"]), "half", "--hdr", false)).toBe("177px");
  });

  it("計器グラフは、行の数に合う高さとグラフの高さの大きいほう", () => {
    expect(listHeightCss(widget("t", "TrendStack", 1, 1), "half", "--hdr", false)).toMatch(/^max\(\d+px, max\(240px,/);
  });
});

describe("valueTiles（今の値のタイル）", () => {
  const sensors = [
    { id: "a", name: "温度", unit: "℃" },
    { id: "b", name: "湿度", unit: "%" },
    { id: "c", name: "気圧", unit: "hPa" },
  ] as Sensor[];
  const graph = (id: string, ids: string[], row: number, config = {}) => ({ ...widget(id, "SensorGraph", row, 1), config: { sensorIds: ids, ...config } });

  it("グラフのセンサーを並び順に全部（複数センサーのグラフも）。同じセンサーは 1 つ。タップ先は最初のグラフ", () => {
    const tiles = valueTiles([graph("g2", ["b", "c"], 5), graph("g1", ["a", "b"], 1)], sensors);
    expect(tiles.map((t) => [t.sensorId, t.widgetId, t.name, t.unit])).toEqual([
      ["a", "g1", "温度", "℃"],
      ["b", "g1", "湿度", "%"],
      ["c", "g2", "気圧", "hPa"],
    ]);
  });

  it("数値の部品（StatValue・メーター・計器）が出しているセンサーは出さない。系列名があればそれを名前にする", () => {
    const stat = { ...widget("s", "StatValue", 1, 1), sensorId: "a" };
    const tiles = valueTiles([stat, graph("g", ["a", "b"], 5, { seriesNames: { b: "作業室 湿度" } })], sensors);
    expect(tiles.map((t) => [t.sensorId, t.name])).toEqual([["b", "作業室 湿度"]]);
  });

  it("計器（TapeGauge）・計器グラフ（TrendStack）が今の値を出しているセンサーも、タイルにしない。全部そうなら 0 個（タイル欄を出さない）", () => {
    const tape = { ...widget("t", "TapeGauge", 1, 1), sensorId: "a" };
    const trend = { ...widget("r", "TrendStack", 2, 1), config: { sensorIds: ["b", "c"] } };
    expect(valueTiles([tape, trend, graph("g", ["a", "b", "c"], 5)], sensors)).toEqual([]);
    // 一部だけなら、残りのセンサーだけ
    expect(valueTiles([tape, graph("g", ["a", "b"], 5)], sensors).map((t) => t.sensorId)).toEqual(["b"]);
  });

  it("グラフが無ければ、タイルも無い", () => {
    expect(valueTiles([widget("x", "FloorPlan", 1, 1)], sensors)).toEqual([]);
  });
});
