import { describe, expect, it } from "vitest";

import type { Widget, WidgetType } from "../types";
import { GRAPH_MIN_HEIGHT_PX, graphHeightCss, isSmallListWidget, listHeightCss, listWidgets } from "./dashboard-link";

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
    expect(listHeightCss(strip(["a", "b"]), "half", "--hdr", false)).toBe("244px");
    expect(listHeightCss(strip(["a"]), "half", "--hdr", false)).toBe("192px");
  });

  it("計器グラフは、行の数に合う高さとグラフの高さの大きいほう", () => {
    expect(listHeightCss(widget("t", "TrendStack", 1, 1), "half", "--hdr", false)).toMatch(/^max\(\d+px, max\(240px,/);
  });
});
