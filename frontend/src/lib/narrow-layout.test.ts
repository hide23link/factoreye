import { describe, expect, it } from "vitest";

import type { Widget } from "../types";
import { groupNarrowWidgets, narrowHeightPx, widgetsInReadingOrder } from "./narrow-layout";

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

  it("系統図は 1 列の短い高さ（機器は横に並べて、横にスクロールするため）", () => {
    expect(narrowHeightPx(w("d", 1, 1, "DeviceTree"))).toBe(200);
  });

  it("計器が 2 つ続くところは 2 列に並べ、奇数個の最後や、計器でないものは 1 列のまま", () => {
    const groups = groupNarrowWidgets([
      w("t1", 1, 1, "TapeGauge"),
      w("t2", 1, 4, "TapeGauge"),
      w("t3", 1, 7, "TapeGauge"),
      w("g", 2, 1, "TrendStack"),
      w("t4", 3, 1, "TapeGauge"),
    ]);
    expect(groups.map((g) => ({ pair: g.pair, ids: g.widgets.map((x) => x.id) }))).toEqual([
      { pair: true, ids: ["t1", "t2"] },
      { pair: false, ids: ["t3"] },
      { pair: false, ids: ["g"] },
      { pair: false, ids: ["t4"] },
    ]);
  });
});
