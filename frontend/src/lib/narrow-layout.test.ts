import { describe, expect, it } from "vitest";

import type { Widget } from "../types";
import { narrowHeightPx, widgetsInReadingOrder } from "./narrow-layout";

describe("スマホの縦 1 列の並び", () => {
  const w = (id: string, row: number, column: number, type: Widget["type"] = "StatValue", config: Widget["config"] = {}): Widget => ({
    id,
    dashboardId: "d1",
    sensorId: null,
    type,
    gridColumn: column,
    gridRow: row,
    gridWidth: 3,
    gridHeight: 4,
    config,
    createdAt: "",
    updatedAt: "",
  });

  it("置いた位置の順（上の段から、同じ段なら左から）に並べる", () => {
    const order = widgetsInReadingOrder([w("c", 6, 1), w("b", 1, 10), w("a", 1, 1)]).map((x) => x.id);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("計器は低く、計器グラフは行の数に合わせた高さにする", () => {
    expect(narrowHeightPx(w("t", 1, 1, "TapeGauge"))).toBe(168);
    expect(narrowHeightPx(w("g", 1, 1, "TrendStack", { sensorIds: ["a", "b", "c"] }))).toBe(56 + 96 * 3);
    expect(narrowHeightPx(w("s", 1, 1))).toBe(320);
  });
});
