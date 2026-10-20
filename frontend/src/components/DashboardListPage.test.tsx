import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import { useUiStore } from "../store/useUiStore";
import type { Dashboard, Sensor } from "../types";
import { DashboardListPage } from "./DashboardListPage";

vi.mock("../lib/api", () => ({
  fetchDashboards: vi.fn(),
  fetchDashboard: vi.fn(),
  fetchSensors: vi.fn(),
  createDashboard: vi.fn(),
  addWidget: vi.fn(),
}));

import * as api from "../lib/api";

const dashboards: Dashboard[] = [
  {
    id: "d1",
    name: "工場A監視",
    description: "メイン工場",
    layoutConfig: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "d2",
    name: "工場B監視",
    description: null,
    layoutConfig: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
];

function sensor(id: string, name: string, unit: string): Sensor {
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

beforeEach(() => {
  useUiStore.setState({ selectedDashboardId: null, openInEditMode: false });
  vi.mocked(api.fetchSensors).mockResolvedValue([sensor("c", "ライン1 生産数", "個"), sensor("r", "ライン1 稼働", "")]);
  vi.mocked(api.fetchDashboard).mockImplementation(async (id) => ({
    ...dashboards[0],
    id,
    widgets: [
      {
        id: "w1",
        dashboardId: id,
        sensorId: null,
        type: "ProductionPlan",
        gridColumn: 1,
        gridRow: 1,
        gridWidth: 6,
        gridHeight: 6,
        config: {},
        createdAt: "",
        updatedAt: "",
      },
    ],
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DashboardListPage", () => {
  it("ダッシュボード一覧を、ウィジェットの数つきのカードで表示する", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);

    renderWithQueryClient(<DashboardListPage />);

    expect(await screen.findByText("工場A監視")).toBeInTheDocument();
    expect(screen.getByText("工場B監視")).toBeInTheDocument();
    expect(await screen.findAllByText(/ウィジェット 1/)).toHaveLength(2);
  });

  it("カードを押すと、そのダッシュボードを開く", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);

    renderWithQueryClient(<DashboardListPage />);
    await user.click(await screen.findByRole("button", { name: /工場A監視/ }));

    expect(useUiStore.getState().selectedDashboardId).toBe("d1");
    expect(useUiStore.getState().openInEditMode).toBe(false);
  });

  it("ダッシュボードが0件のときセットアップガイドボタンを表示する", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);

    renderWithQueryClient(<DashboardListPage />);

    expect(await screen.findByRole("button", { name: "セットアップガイドを始める" })).toBeInTheDocument();
  });

  it("「新しいダッシュボード」で型を選ぶ小窓を開き、キャンセルで閉じる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);

    renderWithQueryClient(<DashboardListPage />);
    await user.click(await screen.findByRole("button", { name: /新しいダッシュボード/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("からっぽ");
    expect(dialog).toHaveTextContent("設備監視");
    expect(dialog).toHaveTextContent("生産管理");
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("からっぽ: 名前を入れて作ると createDashboard を呼び、編集モードで開く", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockResolvedValue({ ...dashboards[0], id: "d-new", name: "新ダッシュボード", widgets: [] });

    renderWithQueryClient(<DashboardListPage />);
    await user.click(await screen.findByRole("button", { name: /新しいダッシュボード/ }));
    await user.type(screen.getByPlaceholderText("新しいダッシュボード名"), "新ダッシュボード");
    await user.click(screen.getByRole("button", { name: /からっぽ/ }));

    await waitFor(() => expect(api.createDashboard).toHaveBeenCalledWith({ name: "新ダッシュボード" }));
    expect(api.addWidget).not.toHaveBeenCalled();
    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d-new"));
    expect(useUiStore.getState().openInEditMode).toBe(true);
  });

  it("生産管理: 名前が空なら型の名前になり、合うセンサーでウィジェットを並べる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockResolvedValue({ ...dashboards[0], id: "d-new", name: "新しい生産管理", widgets: [] });
    vi.mocked(api.addWidget).mockResolvedValue({ ...(await api.fetchDashboard("x")).widgets[0] });

    renderWithQueryClient(<DashboardListPage />);
    await user.click(await screen.findByRole("button", { name: /新しいダッシュボード/ }));
    // センサーの取得を待つ（取得中は型のボタンを押せない）
    await waitFor(() => expect(screen.getByRole("button", { name: /生産管理/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /生産管理/ }));

    await waitFor(() => expect(api.createDashboard).toHaveBeenCalledWith({ name: "新しい生産管理" }));
    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(3));
    const calls = vi.mocked(api.addWidget).mock.calls.map((c) => [c[0], c[1].type, c[1].sensorId]);
    expect(calls).toEqual([
      ["d-new", "ProductionPlan", "c"],
      ["d-new", "ProductionStatus", "r"],
      ["d-new", "SensorGraph", "c"],
    ]);
  });

  it("作成に失敗したら、小窓にエラーを出して閉じない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockRejectedValue(new Error("network"));

    renderWithQueryClient(<DashboardListPage />);
    await user.click(await screen.findByRole("button", { name: /新しいダッシュボード/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /からっぽ/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /からっぽ/ }));

    expect(await screen.findByText(/ダッシュボードの作成に失敗しました/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
