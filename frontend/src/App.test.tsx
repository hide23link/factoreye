import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { useThemeStore } from "./store/useThemeStore";
import { useUiStore } from "./store/useUiStore";
import { renderWithQueryClient, screen, within } from "./test/test-utils";
import type { DashboardDetail, Widget } from "./types";

vi.mock("./lib/api", () => ({
  fetchHealth: vi.fn(),
  fetchDashboard: vi.fn(),
  fetchDashboards: vi.fn(),
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  createDashboard: vi.fn(),
  fetchMe: vi.fn(),
  fetchAlarms: vi.fn(),
  fetchDisplaySettings: vi.fn(),
  logout: vi.fn(),
  refreshTokens: vi.fn(),
}));

import * as api from "./lib/api";

const graph: Widget = {
  id: "w1",
  dashboardId: "d1",
  sensorId: "s1",
  type: "SensorGraph",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 6,
  gridHeight: 6,
  config: { title: "炉の温度" },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};
const dashboard: DashboardDetail = {
  id: "d1",
  name: "ライン1",
  description: null,
  layoutConfig: {},
  widgets: [graph],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};
const initialUi = useUiStore.getState();

beforeEach(() => {
  vi.mocked(api.fetchHealth).mockResolvedValue({ status: "ok" } as Awaited<ReturnType<typeof api.fetchHealth>>);
  vi.mocked(api.fetchDashboard).mockResolvedValue(dashboard);
  vi.mocked(api.fetchDashboards).mockResolvedValue([dashboard]);
  vi.mocked(api.fetchSensors).mockResolvedValue([]);
  vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });
  vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState(initialUi, true);
  useThemeStore.setState({ mode: "dark", applied: "dark", saved: false });
  document.documentElement.removeAttribute("data-theme");
});

describe("App の画面の分け方", () => {
  it("リンクで開いたときは、ヘッダー・メニュー・下のメニューを出さず、グラフ 1 つの画面を出す", async () => {
    useUiStore.setState({ graphLink: { dashboardId: "d1", graphId: "w1", rangeMinutes: 30 } });
    renderWithQueryClient(<App />);

    expect(await screen.findByText("炉の温度")).toBeInTheDocument();
    expect(screen.queryByText("FactorEye")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "画面の切り替え" })).not.toBeInTheDocument();
  });

  it("リンクが無ければ、ヘッダー・下のメニューつきで、ダッシュボード（一覧ではなく、先頭のもの）を開く", async () => {
    renderWithQueryClient(<App />);

    expect(await screen.findByText("炉の温度")).toBeInTheDocument();
    expect(screen.queryByText("ダッシュボード一覧")).not.toBeInTheDocument();
    expect(screen.getByText("FactorEye")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "画面の切り替え" })).toBeInTheDocument();
  });

  it("左のメニューの「ダッシュボード」の下に、ダッシュボード名が並び、今のものに印が付く", async () => {
    renderWithQueryClient(<App />);

    const rail = await screen.findByRole("navigation", { name: "メインメニュー" });
    const list = await within(rail).findByRole("list", { name: "ダッシュボードの切り替え" });
    expect(within(list).getByRole("button", { name: "ライン1" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).queryByRole("button", { name: "＋ 新しいダッシュボード" })).not.toBeInTheDocument();
  });

  it("左のメニューに全体監視があり、上の帯に警報・注意の表示灯を出す", async () => {
    renderWithQueryClient(<App />);

    const rail = await screen.findByRole("navigation", { name: "メインメニュー" });
    expect(within(rail).getByRole("button", { name: "全体監視" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "ダッシュボード" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("button", { name: /警報 0 件/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /注意 0 件/ })).toBeInTheDocument();
  });

  it("警報・注意は重さで分けて数え、押すと全体監視へ移る", async () => {
    const alarm = (id: string, severity: "warning" | "critical") => ({
      id,
      sensorId: "s",
      triggeredAt: "2026-11-18T00:00:00Z",
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      value: 1,
      status: "active" as const,
      thresholdBreached: "max" as const,
      severity,
    });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [alarm("1", "critical"), alarm("2", "warning"), alarm("3", "warning")], total: 3 });
    renderWithQueryClient(<App />);

    const lamp = await screen.findByRole("button", { name: /警報 1 件/ });
    expect(screen.getByRole("button", { name: /注意 2 件/ })).toBeInTheDocument();
    lamp.click();
    expect(useUiStore.getState().view).toBe("overview");
  });

  it("画面表示モード（kiosk）は、前と同じくヘッダーと下のメニューを隠す", async () => {
    useUiStore.setState({ selectedDashboardId: "d1", kiosk: true });
    renderWithQueryClient(<App />);

    expect(await screen.findByText("炉の温度")).toBeInTheDocument();
    expect(screen.queryByText("FactorEye")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "画面の切り替え" })).not.toBeInTheDocument();
  });

  it("画面の明るさ: この端末で選んでいなければ、サーバーの「全員の初期値」で始まる。選んでいれば、その選択が優先", async () => {
    vi.mocked(api.fetchDisplaySettings).mockResolvedValue({ defaultTheme: "light" });
    useThemeStore.setState({ mode: "dark", applied: "dark", saved: false });
    renderWithQueryClient(<App />);

    await vi.waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    expect(useThemeStore.getState().mode).toBe("light");
    // 端末の選択が無いままなので、保存はしていない
    expect(localStorage.getItem("factoreye.theme")).toBeNull();

    // この端末で「暗い」を選んでいる場合は、全員の初期値より優先する
    useThemeStore.setState({ mode: "dark", applied: "dark", saved: true });
    useThemeStore.getState().applyServerDefault("light");
    expect(useThemeStore.getState().mode).toBe("dark");
  });

  it("画面表示モード（壁掛け）の間は、全員の初期値が明るくても常に暗い。抜けると明るさに戻る", async () => {
    vi.mocked(api.fetchDisplaySettings).mockResolvedValue({ defaultTheme: "light" });
    useUiStore.setState({ view: "main", selectedDashboardId: "d1", kiosk: true });
    renderWithQueryClient(<App />);

    await vi.waitFor(() => expect(useThemeStore.getState().mode).toBe("light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    act(() => useUiStore.setState({ kiosk: false }));
    await vi.waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
  });
});
