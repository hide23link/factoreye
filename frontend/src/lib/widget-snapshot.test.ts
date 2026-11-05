import { describe, expect, it } from "vitest";

import type { Widget } from "../types";
import { planRestore } from "./widget-snapshot";

function make(id: string, overrides: Partial<Widget> = {}): Widget {
  return {
    id,
    dashboardId: "d1",
    sensorId: "s1",
    type: "SensorGraph",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 4,
    gridHeight: 4,
    config: { graphType: "line" },
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("planRestore", () => {
  it("同じなら何もしない", () => {
    expect(planRestore([make("a")], [make("a")])).toEqual({ deleteIds: [], recreate: [], update: [] });
  });

  it("追加された分は消す（追加の取り消し）", () => {
    expect(planRestore([make("a"), make("b")], [make("a")]).deleteIds).toEqual(["b"]);
  });

  it("削除された分は作り直す（削除の取り消し）", () => {
    const plan = planRestore([make("a")], [make("a"), make("b")]);
    expect(plan.recreate.map((w) => w.id)).toEqual(["b"]);
  });

  it("位置・サイズ・センサー・設定の違いは更新する", () => {
    const snapshot = [make("a"), make("b"), make("c"), make("d")];
    const current = [
      make("a", { gridRow: 3 }),
      make("b", { gridWidth: 6 }),
      make("c", { sensorId: "s2" }),
      make("d", { config: { graphType: "bar" } }),
    ];
    expect(planRestore(current, snapshot).update.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("更新日時だけの違いは無視する", () => {
    expect(planRestore([make("a", { updatedAt: "x" })], [make("a")]).update).toEqual([]);
  });
});
