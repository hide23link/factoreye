import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("リンクのグラフが見つからないときは、リンクの画面をやめて一覧を開き、帯を出す。ほかの画面へ移ると帯は消える", () => {
    useUiStore.setState({ graphLink: { dashboardId: "d1", graphId: "w1", rangeMinutes: 30 }, selectedDashboardId: "d1" });
    useUiStore.getState().showLinkNotFound();
    expect(useUiStore.getState().graphLink).toBeNull();
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
    expect(useUiStore.getState().linkNotFound).toBe(true);

    useUiStore.getState().selectDashboard("d2");
    expect(useUiStore.getState().linkNotFound).toBe(false);
  });

  it("開いたときの URL がリンクなら、そのグラフの画面から始める（SaaS はログインの後もこの状態のまま）", async () => {
    window.history.replaceState(null, "", "/?dashboard=3f8c2a1e-7b4d-4e19-9a52-c0d1e6f2a8b3&graph=9d41b7c2-0e5a-4f38-b1d6-7a2c9e4f0b13&range=60m");
    vi.resetModules();
    const { useUiStore: fresh } = await import("./useUiStore");
    window.history.replaceState(null, "", "/");
    expect(fresh.getState().graphLink).toEqual({ dashboardId: "3f8c2a1e-7b4d-4e19-9a52-c0d1e6f2a8b3", graphId: "9d41b7c2-0e5a-4f38-b1d6-7a2c9e4f0b13", rangeMinutes: 60 });
    expect(fresh.getState().linkNotFound).toBe(false);
  });
});

