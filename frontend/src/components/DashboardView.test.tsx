import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import type { DashboardDetail } from "../types";
import { DashboardView } from "./DashboardView";

vi.mock("../lib/api", () => ({
  fetchDashboard: vi.fn(),
  deleteDashboard: vi.fn(),
  updateDashboard: vi.fn(),
  updateWidget: vi.fn(),
  addWidget: vi.fn(),
  fetchSensors: vi.fn(),
}));

import * as api from "../lib/api";

const emptyDashboard: DashboardDetail = {
  id: "d1",
  name: "工場A",
  description: "メイン工場の監視",
  layoutConfig: {},
  widgets: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DashboardView", () => {
  it("ローディング中はスピナーテキストを表示する", () => {
    vi.mocked(api.fetchDashboard).mockReturnValue(new Promise(() => {}));

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
  });

  it("ダッシュボード名と説明を表示する", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    expect(await screen.findByText("工場A")).toBeInTheDocument();
    expect(screen.getByText("メイン工場の監視")).toBeInTheDocument();
  });

  it("ウィジェットが0件のときガイドメッセージを表示する", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    expect(await screen.findByText(/まだウィジェットがありません/)).toBeInTheDocument();
  });

  it("設定ボタンを押すと設定モーダルが開く", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    await screen.findByText("工場A");
    await user.click(screen.getByRole("button", { name: "ダッシュボード設定" }));

    expect(screen.getByText("ダッシュボード設定")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "キャンセル" })).toBeInTheDocument();
  });

  it("設定モーダルのキャンセルで閉じる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    await screen.findByText("工場A");
    await user.click(screen.getByRole("button", { name: "ダッシュボード設定" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("設定モーダルで保存するとupdateDashboardを呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.updateDashboard).mockResolvedValue({ ...emptyDashboard, name: "工場A更新" });

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    await screen.findByText("工場A");
    await user.click(screen.getByRole("button", { name: "ダッシュボード設定" }));

    const nameInput = screen.getByRole("textbox", { name: /名前/ });
    await user.clear(nameInput);
    await user.type(nameInput, "工場A更新");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(api.updateDashboard).toHaveBeenCalledWith("d1", expect.objectContaining({ name: "工場A更新" })),
    );
  });
});
