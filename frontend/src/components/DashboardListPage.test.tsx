import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import type { Dashboard } from "../types";
import { DashboardListPage } from "./DashboardListPage";

vi.mock("../lib/api", () => ({
  fetchDashboards: vi.fn(),
  createDashboard: vi.fn(),
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DashboardListPage", () => {
  it("ダッシュボード一覧を表示する", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);

    renderWithQueryClient(<DashboardListPage />);

    expect(await screen.findByText("工場A監視")).toBeInTheDocument();
    expect(screen.getByText("工場B監視")).toBeInTheDocument();
    expect(screen.getByText("メイン工場")).toBeInTheDocument();
  });

  it("ダッシュボードが0件のときセットアップガイドボタンを表示する", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);

    renderWithQueryClient(<DashboardListPage />);

    expect(await screen.findByRole("button", { name: "セットアップガイドを始める" })).toBeInTheDocument();
  });

  it("名前を入力して作成ボタンを押すとcreateDashboardを呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockResolvedValue({
      ...dashboards[0],
      id: "d-new",
      name: "新ダッシュボード",
    });

    renderWithQueryClient(<DashboardListPage />);

    await screen.findByRole("button", { name: "セットアップガイドを始める" });

    await user.type(screen.getByPlaceholderText("新しいダッシュボード名"), "新ダッシュボード");
    await user.click(screen.getByRole("button", { name: "作成" }));

    await waitFor(() =>
      expect(api.createDashboard).toHaveBeenCalledWith({ name: "新ダッシュボード" }),
    );
  });

  it("名前が空のときは作成ボタンが無効", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);

    renderWithQueryClient(<DashboardListPage />);

    await screen.findByRole("button", { name: "セットアップガイドを始める" });

    const submitBtn = screen.getByRole("button", { name: "作成" });
    expect(submitBtn).toBeDisabled();
  });
});
