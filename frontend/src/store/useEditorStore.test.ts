import { beforeEach, describe, expect, it } from "vitest";

import type { Widget } from "../types";
import { useEditorStore } from "./useEditorStore";

const snapshot = (id: string): Widget[] => [
  {
    id,
    dashboardId: "d",
    sensorId: null,
    type: "AlarmAlert",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 1,
    gridHeight: 1,
    config: {},
    createdAt: "",
    updatedAt: "",
  },
];

beforeEach(() => useEditorStore.getState().reset());

describe("useEditorStore", () => {
  it("編集を始めると編集中になり、選択は空になる", () => {
    useEditorStore.getState().select("w1");
    useEditorStore.getState().startEditing();
    expect(useEditorStore.getState()).toMatchObject({ editing: true, selectedWidgetId: null });
  });

  it("履歴は新しい順に取り出せる。空なら null", () => {
    const s = useEditorStore.getState();
    s.pushHistory(snapshot("a"));
    s.pushHistory(snapshot("b"));
    expect(useEditorStore.getState().popHistory()?.[0].id).toBe("b");
    expect(useEditorStore.getState().popHistory()?.[0].id).toBe("a");
    expect(useEditorStore.getState().popHistory()).toBeNull();
  });

  it("履歴は 50 件まで", () => {
    for (let i = 0; i < 60; i += 1) useEditorStore.getState().pushHistory(snapshot(String(i)));
    expect(useEditorStore.getState().history).toHaveLength(50);
    expect(useEditorStore.getState().history[0][0].id).toBe("10");
  });

  it("編集を終えると、履歴・通知・ドラッグ中の状態を捨てる", () => {
    const s = useEditorStore.getState();
    s.startEditing();
    s.pushHistory(snapshot("a"));
    s.showToast("x");
    s.setDragging({ kind: "sensor", sensorId: "s1" });
    s.stopEditing();
    expect(useEditorStore.getState()).toMatchObject({ editing: false, history: [], toast: null, dragging: null });
  });
});
