import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { useUiStore } from "./store/useUiStore";
import { renderWithQueryClient, screen } from "./test/test-utils";
import type { DashboardDetail, Widget } from "./types";

vi.mock("./lib/api", () => ({
  fetchHealth: vi.fn(),
  fetchDashboard: vi.fn(),
  fetchDashboards: vi.fn(),
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  createDashboard: vi.fn(),
  fetchMe: vi.fn(),
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
});

afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState(initialUi, true);
});

describe("App の画面の分け方", () => {
  it("リンクで開いたときは、ヘッダー・メニュー・下のメニューを出さず、グラフ 1 つの画面を出す", async () => {
    useUiStore.setState({ graphLink: { dashboardId: "d1", graphId: "w1", rangeMinutes: 30 } });
    renderWithQueryClient(<App />);

    expect(await screen.findByText("炉の温度")).toBeInTheDocument();
    expect(screen.queryByText("FactorEye")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "画面の切り替え" })).not.toBeInTheDocument();
  });

  it("リンクが無ければ、前と同じくヘッダー・下のメニューつきの一覧を出す", async () => {
    renderWithQueryClient(<App />);

    expect(await screen.findByText("ダッシュボード一覧")).toBeInTheDocument();
    expect(screen.getByText("FactorEye")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "画面の切り替え" })).toBeInTheDocument();
  });

  it("画面表示モード（kiosk）は、前と同じくヘッダーと下のメニューを隠す", async () => {
    useUiStore.setState({ selectedDashboardId: "d1", kiosk: true });
    renderWithQueryClient(<App />);

    expect(await screen.findByText("炉の温度")).toBeInTheDocument();
    expect(screen.queryByText("FactorEye")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "画面の切り替え" })).not.toBeInTheDocument();
  });
});
