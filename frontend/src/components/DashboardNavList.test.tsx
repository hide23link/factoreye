import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import { readLastDashboardId } from "../lib/last-dashboard";
import { useEditorStore } from "../store/useEditorStore";
import { useUiStore } from "../store/useUiStore";
import type { Dashboard } from "../types";
import { DashboardNavList } from "./DashboardNavList";

vi.mock("../lib/api", () => ({
  fetchDashboards: vi.fn(),
  createDashboard: vi.fn(),
}));

import * as api from "../lib/api";

const base = { description: null, layoutConfig: {}, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" };
const dashboards: Dashboard[] = [
  { ...base, id: "d1", name: "事務室" },
  { ...base, id: "d2", name: "環境センサー（6か所）" },
];

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ selectedDashboardId: "d1", view: "main", kiosk: false, openInEditMode: false });
  useEditorStore.setState({ editing: false });
  vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);
});

describe("DashboardNavList（左のメニューのダッシュボード名）", () => {
  it("全ダッシュボードの名前を並べ、今のものに印を付ける。最後に「＋ 新しいダッシュボード」", async () => {
    renderWithQueryClient(<DashboardNavList />);
    await screen.findByRole("button", { name: "事務室" });
    const items = screen.getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual(["事務室", "環境センサー（6か所）", "＋ 新しいダッシュボード"]);
    expect(screen.getByRole("button", { name: "事務室" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "環境センサー（6か所）" })).not.toHaveAttribute("aria-current");
  });

  it("名前を押すと、そのダッシュボードへ切り替わり、最後に見たものとして覚える", async () => {
    renderWithQueryClient(<DashboardNavList />);
    await userEvent.click(await screen.findByRole("button", { name: "環境センサー（6か所）" }));
    expect(useUiStore.getState().selectedDashboardId).toBe("d2");
    expect(readLastDashboardId()).toBe("d2");
  });

  it("ほかの画面（設定など）を見ているときは、印を付けない。押すとダッシュボードへ戻る", async () => {
    useUiStore.setState({ view: "settings" });
    renderWithQueryClient(<DashboardNavList />);
    const item = await screen.findByRole("button", { name: "事務室" });
    expect(item).not.toHaveAttribute("aria-current");
    await userEvent.click(item);
    expect(useUiStore.getState().view).toBe("main");
  });

  it("編集中は押せず、押しても移らない", async () => {
    useEditorStore.setState({ editing: true });
    renderWithQueryClient(<DashboardNavList />);
    const item = await screen.findByRole("button", { name: "環境センサー（6か所）" });
    expect(item).toBeDisabled();
    expect(screen.getByRole("button", { name: "＋ 新しいダッシュボード" })).toBeDisabled();
    await userEvent.click(item);
    expect(useUiStore.getState().selectedDashboardId).toBe("d1");
  });

  it("「＋ 新しいダッシュボード」で、連番の名前の空のダッシュボードを作り、編集モードで開く", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue([{ ...base, id: "x", name: "新しいダッシュボード" }]);
    vi.mocked(api.createDashboard).mockResolvedValue({ ...base, id: "d-new", name: "新しいダッシュボード 2", widgets: [] });
    renderWithQueryClient(<DashboardNavList />);
    await userEvent.click(await screen.findByRole("button", { name: "＋ 新しいダッシュボード" }));
    await waitFor(() => expect(api.createDashboard).toHaveBeenCalledWith({ name: "新しいダッシュボード 2" }));
    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d-new"));
    expect(useUiStore.getState().openInEditMode).toBe(true);
  });

  it("作成に失敗したら、エラーを出して今のダッシュボードのまま", async () => {
    vi.mocked(api.createDashboard).mockRejectedValue(new Error("network"));
    renderWithQueryClient(<DashboardNavList />);
    await userEvent.click(await screen.findByRole("button", { name: "＋ 新しいダッシュボード" }));
    expect(await screen.findByText(/ダッシュボードの作成に失敗しました/)).toBeInTheDocument();
    expect(useUiStore.getState().selectedDashboardId).toBe("d1");
  });
});
