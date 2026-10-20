import { afterEach, describe, expect, it } from "vitest";

import { useUiStore } from "./useUiStore";

const initialState = useUiStore.getState();

afterEach(() => {
  useUiStore.setState(initialState, true);
});

describe("useUiStore", () => {
  it("初期状態はmain画面・未選択", () => {
    expect(useUiStore.getState().view).toBe("main");
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
  });

  it("setViewで画面を切り替える", () => {
    useUiStore.getState().setView("settings");
    expect(useUiStore.getState().view).toBe("settings");
  });

  it("selectDashboardはダッシュボードを選び、常にmain画面へ戻す", () => {
    useUiStore.getState().setView("wizard");
    useUiStore.getState().selectDashboard("dash-1");
    expect(useUiStore.getState().selectedDashboardId).toBe("dash-1");
    expect(useUiStore.getState().view).toBe("main");
  });

  it("selectDashboardは、指定したときだけ編集モードで開く", () => {
    useUiStore.getState().selectDashboard("dash-1", { edit: true });
    expect(useUiStore.getState().openInEditMode).toBe(true);
    useUiStore.getState().selectDashboard("dash-2");
    expect(useUiStore.getState().openInEditMode).toBe(false);
  });
});
