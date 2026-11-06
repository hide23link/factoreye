import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, renderWithQueryClient, screen } from "../test/test-utils";
import { useKioskStore } from "../store/useKioskStore";
import { useUiStore } from "../store/useUiStore";
import { KioskBar } from "./KioskBar";

vi.mock("../lib/api", () => ({
  fetchDashboards: vi.fn(),
}));
import * as api from "../lib/api";

const dashboards = ["a", "b", "c"].map((id) => ({
  id,
  name: `ボード${id}`,
  description: null,
  layoutConfig: {},
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
}));

beforeEach(() => {
  localStorage.clear();
  useKioskStore.setState({ scale: 1, fit: true, cycleSeconds: 0, cycleExcluded: [] });
  useUiStore.setState({ selectedDashboardId: "a", kiosk: true });
  vi.mocked(api.fetchDashboards).mockResolvedValue(dashboards);
});
afterEach(cleanup);

describe("KioskBar", () => {
  it("サイズ・収め方を変えると、設定が端末に保存される", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<KioskBar dashboardId="a" onExit={() => {}} onInteract={() => {}} />);

    await user.click(screen.getByRole("button", { name: "150%" }));
    await user.click(screen.getByRole("button", { name: "1 画面に収める" }));

    expect(useKioskStore.getState()).toMatchObject({ scale: 1.5, fit: false });
    expect(JSON.parse(localStorage.getItem("factoreye.kiosk") ?? "{}")).toMatchObject({ scale: 1.5, fit: false });
  });

  it("「次」で画面表示モードを保ったまま次のダッシュボードへ移る", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<KioskBar dashboardId="a" onExit={() => {}} onInteract={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "次のダッシュボード" }));

    expect(useUiStore.getState()).toMatchObject({ selectedDashboardId: "b", kiosk: true });
  });

  it("自動切替の間隔を選ぶと、切替の対象を外せる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<KioskBar dashboardId="a" onExit={() => {}} onInteract={() => {}} />);

    await user.selectOptions(await screen.findByLabelText("自動切替の間隔"), "30");
    await user.click(screen.getByText("切替の対象"));
    await user.click(screen.getByRole("checkbox", { name: "ボードc" }));

    expect(useKioskStore.getState()).toMatchObject({ cycleSeconds: 30, cycleExcluded: ["c"] });
  });

  it("操作すると onInteract を呼ぶ（バーが隠れるまでの時間を延ばすため）", async () => {
    const onInteract = vi.fn();
    const user = userEvent.setup();
    renderWithQueryClient(<KioskBar dashboardId="a" onExit={() => {}} onInteract={onInteract} />);

    await user.click(screen.getByRole("button", { name: "200%" }));

    expect(onInteract).toHaveBeenCalled();
  });
});

describe("useKioskStore", () => {
  it("保存された値が壊れていても、既定値で起動する", async () => {
    localStorage.setItem("factoreye.kiosk", JSON.stringify({ scale: 9, fit: "yes", cycleSeconds: 7, cycleExcluded: [1, "x"] }));
    vi.resetModules();
    const { useKioskStore: fresh } = await import("../store/useKioskStore");
    act(() => {});
    expect(fresh.getState()).toMatchObject({ scale: 1, fit: true, cycleSeconds: 0, cycleExcluded: ["x"] });
  });
});
