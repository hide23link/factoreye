import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import { useUiStore } from "../store/useUiStore";
import type { Dashboard } from "../types";
import { DashboardListPage } from "./DashboardListPage";

vi.mock("../lib/api", () => ({
  fetchDashboards: vi.fn(),
  fetchDashboard: vi.fn(),
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

beforeEach(() => {
  useUiStore.setState({ selectedDashboardId: null, openInEditMode: false });
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

  it("「新しいダッシュボード」を押すと、型を選ばず空のダッシュボードを作り、編集モードで開く", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockResolvedValue({ ...dashboards[0], id: "d-new", name: "新しいダッシュボード", widgets: [] });

    renderWithQueryClient(<DashboardListPage />);
    await user.click(await screen.findByRole("button", { name: /新しいダッシュボード/ }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.createDashboard).toHaveBeenCalledWith({ name: "新しいダッシュボード" }));
    expect(api.addWidget).not.toHaveBeenCalled();
    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d-new"));
    expect(useUiStore.getState().openInEditMode).toBe(true);
  });

  it("作成に失敗したら、エラーを出して一覧に留まる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockRejectedValue(new Error("network"));

    renderWithQueryClient(<DashboardListPage />);
    await user.click(await screen.findByRole("button", { name: /新しいダッシュボード/ }));

    expect(await screen.findByText(/ダッシュボードの作成に失敗しました/)).toBeInTheDocument();
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
  });

  it("同じ名前がすでにあるときは、連番を付けて作る（新しいダッシュボード 2）", async () => {
    const user = userEvent.setup();
    const existing = [{ ...dashboards[0], id: "x1", name: "新しいダッシュボード" }];
    vi.mocked(api.fetchDashboards).mockResolvedValue(existing);
    vi.mocked(api.createDashboard).mockResolvedValue({ ...dashboards[0], id: "d-new", name: "新しいダッシュボード 2", widgets: [] });

    renderWithQueryClient(<DashboardListPage />);
    await screen.findAllByRole("button", { name: /新しいダッシュボード/ });
    // 作成のカードは、一覧の最後
    await user.click(screen.getAllByRole("button", { name: /新しいダッシュボード/ }).at(-1)!);

    await waitFor(() => expect(api.createDashboard).toHaveBeenCalledWith({ name: "新しいダッシュボード 2" }));
  });
});
