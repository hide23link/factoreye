import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../test/test-utils";
import { useRefreshStore } from "../store/useRefreshStore";
import { RefreshControls } from "./RefreshControls";

afterEach(() => {
  useRefreshStore.setState({ choice: "graph" });
  localStorage.clear();
});

describe("RefreshControls", () => {
  it("既定は各グラフの設定に従い、「手動」は出ない", () => {
    renderWithQueryClient(<RefreshControls />);

    expect(screen.getByLabelText("更新間隔")).toHaveValue("graph");
    expect(screen.getByTestId("refresh-status")).not.toHaveTextContent("手動");
  });

  it("Off を選ぶと「手動」が出て、端末には保存されない", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<RefreshControls />);

    await user.selectOptions(screen.getByLabelText("更新間隔"), "off");

    expect(screen.getByTestId("refresh-status")).toHaveTextContent("手動");
    expect(useRefreshStore.getState().choice).toBe("off");
    // Off は端末に保存しない（再読み込みで既定に戻る）
    expect(localStorage.getItem("factoreye.refreshInterval")).toBe("graph");
  });

  it("⟳ でウィジェットの測定値だけを取り直し、現在時刻を進める", async () => {
    const spy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const user = userEvent.setup();
    renderWithQueryClient(<RefreshControls />);

    await user.click(screen.getByRole("button", { name: "ウィジェットを今すぐ更新" }));

    expect(spy).toHaveBeenCalledTimes(1);
    const predicate = (spy.mock.calls[0][0] as unknown as { predicate: (q: { queryKey: unknown[] }) => boolean }).predicate;
    expect(predicate({ queryKey: ["readings-downsampled", "s1"] })).toBe(true);
    expect(predicate({ queryKey: ["sensors"] })).toBe(false);
    expect(useRefreshStore.getState().manualAt).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
