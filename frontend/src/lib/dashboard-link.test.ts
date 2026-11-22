import { describe, expect, it } from "vitest";

import type { Widget, WidgetType } from "../types";
import { isListWidget, isSmallListWidget, listHeightPx, listWidgets } from "./dashboard-link";

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

  it.each<WidgetType>(["FloorPlan", "DeviceTree", "TrendStack", "StateTimeline", "TargetStrip", "ProductionPlan"])(
    "%s は一覧に出さない",
    (type) => {
      expect(isListWidget({ type })).toBe(false);
      expect(listWidgets([widget("x", type, 1, 1), widget("g", "SensorGraph", 2, 1)]).map((w) => w.id)).toEqual(["g"]);
    },
  );

  it.each<WidgetType>(["SensorGraph", "MultiSensorComparison", "StatValue", "Gauge", "TapeGauge", "ProductionStatus", "AlarmAlert"])(
    "%s は一覧に出す",
    (type) => expect(isListWidget({ type })).toBe(true),
  );
});

describe("小さい部品と高さ", () => {
  it("数値・メーター・計器・稼働ステータスは小さい部品（縦向きで 2 列）。グラフ・警報は違う", () => {
    expect((["StatValue", "Gauge", "TapeGauge", "ProductionStatus"] as const).every((type) => isSmallListWidget({ type }))).toBe(true);
    expect(isSmallListWidget({ type: "SensorGraph" })).toBe(false);
    expect(isSmallListWidget({ type: "AlarmAlert" })).toBe(false);
  });

  it("グラフは小さい部品より高い", () => {
    expect(listHeightPx({ type: "SensorGraph" })).toBeGreaterThan(listHeightPx({ type: "StatValue" }));
  });
});
