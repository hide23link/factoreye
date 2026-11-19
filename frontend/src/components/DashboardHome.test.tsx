import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import { useUiStore } from "../store/useUiStore";
import type { Dashboard } from "../types";
import { readLastDashboardId, writeLastDashboardId } from "../lib/last-dashboard";
import { DashboardHome, LinkNotFoundNotice } from "./DashboardHome";

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

beforeEach(() => {
  useUiStore.setState({ selectedDashboardId: null, openInEditMode: false, linkNotFound: false });
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DashboardHome（一覧の画面は無い。自動で開く）", () => {
  it("覚えていなければ、先頭のダッシュボードを開く", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);

    renderWithQueryClient(<DashboardHome />);

    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d1"));
  });

  it("最後に見たダッシュボードが今もあれば、それを開く", async () => {
    writeLastDashboardId("d2");
    vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);

    renderWithQueryClient(<DashboardHome />);

    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d2"));
  });

  it("最後に見たダッシュボードが消えていれば、先頭を開く", async () => {
    writeLastDashboardId("gone");
    vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);

    renderWithQueryClient(<DashboardHome />);

    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d1"));
  });

  it("自動で開いても、リンクの「見つからない」の帯は消さない", async () => {
    useUiStore.setState({ linkNotFound: true });
    vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);

    renderWithQueryClient(<DashboardHome />);

    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d1"));
    expect(useUiStore.getState().linkNotFound).toBe(true);
  });

  it("自動で開いたことは、「最後に見たもの」として覚えない（利用者が選んだものだけ覚える）", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);

    renderWithQueryClient(<DashboardHome />);

    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d1"));
    expect(readLastDashboardId()).toBeNull();
  });

  it("ダッシュボードが0件のときセットアップガイドボタンを表示し、何も開かない", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);

    renderWithQueryClient(<DashboardHome />);

    expect(await screen.findByRole("button", { name: "セットアップガイドを始める" })).toBeInTheDocument();
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
  });

  it("取得に失敗したら、エラーと再試行を出す", async () => {
    vi.mocked(api.fetchDashboards).mockRejectedValue(new Error("boom"));

    renderWithQueryClient(<DashboardHome />);

    expect(await screen.findByText("ダッシュボードの一覧を取得できませんでした。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再試行" })).toBeInTheDocument();
  });

  it("0件のとき「新しいダッシュボード」を押すと、型を選ばず空のダッシュボードを作り、編集モードで開く", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockResolvedValue({ ...dashboards[0], id: "d-new", name: "新しいダッシュボード", widgets: [] });

    renderWithQueryClient(<DashboardHome />);
    await user.click(await screen.findByRole("button", { name: /新しいダッシュボード/ }));

    await waitFor(() => expect(api.createDashboard).toHaveBeenCalledWith({ name: "新しいダッシュボード" }));
    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d-new"));
    expect(useUiStore.getState().openInEditMode).toBe(true);
  });

  it("作成に失敗したら、エラーを出して何も開かない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockRejectedValue(new Error("network"));

    renderWithQueryClient(<DashboardHome />);
    await user.click(await screen.findByRole("button", { name: /新しいダッシュボード/ }));

    expect(await screen.findByText(/ダッシュボードの作成に失敗しました/)).toBeInTheDocument();
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
  });
});

describe("LinkNotFoundNotice（リンクのグラフが見つからない帯）", () => {
  it("見つからなかったときだけ出す", () => {
    const { unmount } = renderWithQueryClient(<LinkNotFoundNotice />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    unmount();

    useUiStore.setState({ linkNotFound: true });
    renderWithQueryClient(<LinkNotFoundNotice />);
    expect(screen.getByText("リンクのグラフが見つかりません。消されたか、別のワークスペースのものです。")).toBeInTheDocument();
  });
});
