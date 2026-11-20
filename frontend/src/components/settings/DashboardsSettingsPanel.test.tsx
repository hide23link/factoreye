import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import { useEditorStore } from "../../store/useEditorStore";
import { useUiStore } from "../../store/useUiStore";
import type { Dashboard } from "../../types";
import { DashboardsSettingsPanel } from "./DashboardsSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchDashboards: vi.fn(),
  createDashboard: vi.fn(),
}));

import * as api from "../../lib/api";

const base = { description: null, layoutConfig: {}, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" };
const dashboards: Dashboard[] = [
  { ...base, id: "d1", name: "事務室" },
  { ...base, id: "d2", name: "環境センサー" },
];

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ selectedDashboardId: null, view: "settings", kiosk: false, openInEditMode: false });
  useEditorStore.setState({ editing: false });
  vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);
  vi.mocked(api.createDashboard).mockReset();
});

describe("DashboardsSettingsPanel（設定の「ダッシュボード」）", () => {
  it("名前を入れて「作成」で、その名前の空のダッシュボードを作り、編集モードで開く", async () => {
    vi.mocked(api.createDashboard).mockResolvedValue({ ...base, id: "d-new", name: "ライン3", widgets: [] });
    renderWithQueryClient(<DashboardsSettingsPanel />);
    await screen.findByText("事務室");
    await userEvent.type(screen.getByRole("textbox", { name: "新しいダッシュボードの名前" }), "  ライン3 ");
    await userEvent.click(screen.getByRole("button", { name: "作成" }));
    await waitFor(() => expect(api.createDashboard).toHaveBeenCalledWith({ name: "ライン3" }));
    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d-new"));
    expect(useUiStore.getState().view).toBe("main");
    expect(useUiStore.getState().openInEditMode).toBe(true);
  });

  it("名前が空なら、連番の仮の名前で作る", async () => {
    vi.mocked(api.createDashboard).mockResolvedValue({ ...base, id: "d-new", name: "新しいダッシュボード", widgets: [] });
    renderWithQueryClient(<DashboardsSettingsPanel />);
    await screen.findByText("事務室");
    await userEvent.click(screen.getByRole("button", { name: "作成" }));
    await waitFor(() => expect(api.createDashboard).toHaveBeenCalledWith({ name: "新しいダッシュボード" }));
  });

  it("今ある名前と同じなら、作れず理由を出す", async () => {
    renderWithQueryClient(<DashboardsSettingsPanel />);
    await screen.findByText("事務室");
    await userEvent.type(screen.getByRole("textbox", { name: "新しいダッシュボードの名前" }), "事務室");
    expect(screen.getByRole("button", { name: "作成" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("同じ名前");
    expect(api.createDashboard).not.toHaveBeenCalled();
  });

  it("作成に失敗したら、エラーを出す", async () => {
    vi.mocked(api.createDashboard).mockRejectedValue(new Error("network"));
    renderWithQueryClient(<DashboardsSettingsPanel />);
    await screen.findByText("事務室");
    await userEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(await screen.findByText(/ダッシュボードの作成に失敗しました/)).toBeInTheDocument();
  });

  it("一覧の「開く」で、そのダッシュボードを開く", async () => {
    renderWithQueryClient(<DashboardsSettingsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "環境センサーを開く" }));
    expect(useUiStore.getState().selectedDashboardId).toBe("d2");
    expect(useUiStore.getState().view).toBe("main");
  });

  it("編集中は、作成も開くも押せない", async () => {
    useEditorStore.setState({ editing: true });
    renderWithQueryClient(<DashboardsSettingsPanel />);
    expect(await screen.findByRole("button", { name: "環境センサーを開く" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "作成" })).toBeDisabled();
  });
});
