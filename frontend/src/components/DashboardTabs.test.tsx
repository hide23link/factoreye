import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../test/test-utils";
import { useEditorStore } from "../store/useEditorStore";
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

  it("編集中は押せない", async () => {
    useEditorStore.setState({ editing: true });
    renderWithQueryClient(<DashboardTabs />);
    expect(await screen.findByRole("button", { name: "工場B監視" })).toBeDisabled();
  });

  it("ダッシュボードが無いときは出さない", async () => {
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    const { container } = renderWithQueryClient(<DashboardTabs />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
