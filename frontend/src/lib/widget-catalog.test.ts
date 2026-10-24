import { describe, expect, it } from "vitest";

import { WIDGET_KINDS, widgetChoicesFor, widgetKind, widgetLabel } from "./widget-catalog";

describe("widgetChoicesFor", () => {
  it("計測値は グラフ（おすすめ）・数値・ゲージ", () => {
    expect(widgetChoicesFor("measure")).toEqual(["SensorGraph", "StatValue", "Gauge"]);
  });
  it("生産数は 生産管理（おすすめ）・グラフ・数値", () => {
    expect(widgetChoicesFor("count")).toEqual(["ProductionPlan", "SensorGraph", "StatValue"]);
  });
  it("稼働は 稼働ステータス（おすすめ）・グラフ", () => {
    expect(widgetChoicesFor("state")).toEqual(["ProductionStatus", "SensorGraph"]);
  });
  it("選択肢はすべて、棚に並ぶ種類（作れる種類）", () => {
    for (const kind of ["measure", "count", "state"] as const) {
      for (const type of widgetChoicesFor(kind)) expect(widgetKind(type)).toBeDefined();
    }
  });
});

describe("ゲージの登録", () => {
  it("ゲージは、計測値向けの種類として棚に並ぶ", () => {
    const gauge = WIDGET_KINDS.find((k) => k.type === "Gauge");
    expect(gauge).toMatchObject({ suitedSensor: "measure", width: 4, height: 6 });
    expect(widgetLabel("Gauge")).toBe("ゲージ");
  });
});
