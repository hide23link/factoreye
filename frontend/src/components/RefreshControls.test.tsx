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

  it("Off を選ぶと「手動」が出て、選択が端末に保存される", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<RefreshControls />);

    await user.selectOptions(screen.getByLabelText("更新間隔"), "off");

    expect(screen.getByTestId("refresh-status")).toHaveTextContent("手動");
    expect(useRefreshStore.getState().choice).toBe("off");
    expect(localStorage.getItem("factoreye.refreshInterval")).toBe("off");
  });

  it("⟳ で全部の取得を取り直す", async () => {
    const spy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const user = userEvent.setup();
    renderWithQueryClient(<RefreshControls />);

    await user.click(screen.getByRole("button", { name: "今すぐ更新" }));

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
