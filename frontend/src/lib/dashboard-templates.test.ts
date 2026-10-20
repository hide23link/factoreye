import { describe, expect, it } from "vitest";

import type { Sensor } from "../types";
import { buildTemplateWidgets } from "./dashboard-templates";
import { GRID_COLUMNS, rectOf } from "./grid-placement";

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

const sensors = [sensor("t", "乾燥炉 温度"), sensor("p", "コンプレッサ 圧力", "MPa"), sensor("c", "ライン1 生産数", "個"), sensor("r", "ライン1 稼働", "")];

describe("buildTemplateWidgets", () => {
  it("からっぽは何も置かない", () => {
    expect(buildTemplateWidgets("empty", sensors)).toEqual([]);
  });

  it("設備監視: 計測値のセンサーでグラフと数値、アラーム一覧", () => {
    const widgets = buildTemplateWidgets("equipment", sensors);
    expect(widgets.map((w) => [w.type, w.sensorId])).toEqual([
      ["SensorGraph", "t"],
      ["StatValue", "t"],
      ["AlarmAlert", null],
      ["SensorGraph", "p"],
    ]);
    expect(widgets[0].config).toMatchObject({ showThresholds: true });
  });

  it("生産管理: 生産数で生産管理と棒グラフ、稼働のセンサーで稼働ステータス", () => {
    const widgets = buildTemplateWidgets("production", sensors);
    expect(widgets.map((w) => [w.type, w.sensorId])).toEqual([
      ["ProductionPlan", "c"],
      ["ProductionStatus", "r"],
      ["SensorGraph", "c"],
    ]);
    expect(widgets[2].config).toMatchObject({ graphType: "bar" });
    expect(widgets[0].config).not.toHaveProperty("dailyTarget"); // 目標は未設定で置く
  });

  it("合うセンサーが無いときは、センサー無しで置く", () => {
    const widgets = buildTemplateWidgets("production", []);
    expect(widgets.map((w) => w.sensorId)).toEqual([null, null, null]);
  });

  it.each(["equipment", "production"] as const)("%s のウィジェットは重ならず、12 列に収まる", (key) => {
    const rects = buildTemplateWidgets(key, sensors).map((w) => rectOf(w));
    rects.forEach((r) => expect(r.column + r.width - 1).toBeLessThanOrEqual(GRID_COLUMNS));
    rects.forEach((a, i) =>
      rects.slice(i + 1).forEach((b) => {
        const overlap = a.column < b.column + b.width && b.column < a.column + a.width && a.row < b.row + b.height && b.row < a.row + a.height;
        expect(overlap).toBe(false);
      }),
    );
  });
});
