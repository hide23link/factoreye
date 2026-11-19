import { beforeEach, describe, expect, it } from "vitest";

import { fireEvent, render, screen } from "../../test/test-utils";
import { useGraphViewStore } from "../../store/useGraphViewStore";
import { GraphViewControls } from "./GraphViewControls";

beforeEach(() => {
  localStorage.clear();
  useGraphViewStore.setState({ showBands: true });
});

describe("GraphViewControls（見出しの切り替え）", () => {
  it("警報の帯は既定で入。押すと切になり、端末に保存される。もう一度押すと入に戻る", () => {
    render(<GraphViewControls />);
    const button = screen.getByRole("button", { name: "警報の帯を表示する" });
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(useGraphViewStore.getState().showBands).toBe(false);
    expect(localStorage.getItem("factoreye.graphView")).toContain('"showBands":false');

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});
