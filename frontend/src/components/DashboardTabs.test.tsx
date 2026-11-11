import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fireEvent, renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import { useEditorStore } from "../store/useEditorStore";
import { initTimeRangeFromUrl, resetTimeRange, useTimeRangeStore } from "../store/useTimeRangeStore";
import { useUiStore } from "../store/useUiStore";
import type { Dashboard } from "../types";
import { DashboardTabs } from "./DashboardTabs";

vi.mock("../lib/api", () => ({
  fetchDashboards: vi.fn(),
}));

import * as api from "../lib/api";

const base = { description: null, layoutConfig: {}, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" };
const dashboards: Dashboard[] = [
  { ...base, id: "d1", name: "工場A監視" },
  { ...base, id: "d2", name: "工場B監視" },
];

beforeEach(() => {
  useUiStore.setState({ selectedDashboardId: "d1", view: "main", kiosk: false });
  useEditorStore.setState({ editing: false });
  vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);
});

describe("DashboardTabs", () => {
  it("一覧と全ダッシュボードのタブを並べ、今のタブに印を付ける", async () => {
    renderWithQueryClient(<DashboardTabs />);
    const tabs = await screen.findAllByRole("button");
    expect(tabs.map((t) => t.textContent)).toEqual(["▦ 一覧", "工場A監視", "工場B監視"]);
    expect(screen.getByRole("button", { name: "工場A監視" })).toHaveAttribute("aria-current", "page");
  });

  it("タブを押すと、そのダッシュボードへ切り替わる。一覧タブで一覧へ", async () => {
    renderWithQueryClient(<DashboardTabs />);
    await userEvent.click(await screen.findByRole("button", { name: "工場B監視" }));
    expect(useUiStore.getState().selectedDashboardId).toBe("d2");
    await userEvent.click(screen.getByRole("button", { name: "▦ 一覧" }));
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
  });

  it("編集中は押せず、押しても移らない", async () => {
    useEditorStore.setState({ editing: true });
    renderWithQueryClient(<DashboardTabs />);
    const tab = await screen.findByRole("button", { name: "工場B監視" });
    expect(tab).toBeDisabled();
    await userEvent.click(tab);
    expect(useUiStore.getState().selectedDashboardId).toBe("d1");
  });

  it("タブで移っても、固定の期間をそのまま使う", async () => {
    const fixed = { mode: "absolute" as const, from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 2) };
    useTimeRangeStore.getState().setRange(fixed);
    renderWithQueryClient(<DashboardTabs />);
    // 控えは次の画面を開いた後（すぐ後のタイマー）で消えるので、押してから同期のまま進める
    fireEvent.click(await screen.findByRole("button", { name: "工場B監視" }));
    // 画面の作り直しと同じ順: 閉じる側の片付け → 開く側の読み込み
    resetTimeRange();
    initTimeRangeFromUrl();
    expect(useTimeRangeStore.getState().range).toEqual(fixed);
    resetTimeRange();
  });

  it("ダッシュボードが無いときは出さない", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    const { container } = renderWithQueryClient(<DashboardTabs />);
    await waitFor(() => expect(api.fetchDashboards).toHaveBeenCalled());
    // 取得した結果（0 件）が画面に届くまで待つ
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
