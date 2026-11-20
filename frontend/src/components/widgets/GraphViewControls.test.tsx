import { beforeEach, describe, expect, it, vi } from "vitest";

import { fireEvent, render, screen } from "../../test/test-utils";
import { useGraphViewStore } from "../../store/useGraphViewStore";
import { GraphViewControls } from "./GraphViewControls";

beforeEach(() => {
  localStorage.clear();
  useGraphViewStore.setState({ showBands: true, compare: "none" });
});

describe("GraphViewControls（見出しの切り替え）", () => {
  it("警報の帯は既定で入。押すと切になり、端末に保存される。もう一度押すと入に戻る", () => {
    render(<GraphViewControls rangeFrom={Date.now() - 3_600_000} nowMs={Date.now()} />);
    const button = screen.getByRole("button", { name: "警報の帯を表示する" });
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(useGraphViewStore.getState().showBands).toBe(false);
    expect(localStorage.getItem("factoreye.graphView")).toContain('"showBands":false');

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("比較を選ぶと、端末に保存される。選んだボタンは aria-pressed になる", () => {
    render(<GraphViewControls rangeFrom={Date.now() - 3_600_000} nowMs={Date.now()} />);
    fireEvent.click(screen.getByRole("button", { name: "比較: 昨日" }));
    expect(screen.getByRole("button", { name: "比較: 昨日" })).toHaveAttribute("aria-pressed", "true");
    expect(useGraphViewStore.getState().compare).toBe("yesterday");
    expect(localStorage.getItem("factoreye.graphView")).toContain('"compare":"yesterday"');
  });

  it("保持期間（SaaS は 14 日）の外になる比較は、押せず、理由が出る", () => {
    vi.stubEnv("VITE_AUTH_MODE", "multi_tenant");
    const now = Date.now();
    // 範囲の始めが 8 日前 → 昨日（9 日前）は OK、先週（15 日前）は保持期間の外
    render(<GraphViewControls rangeFrom={now - 8 * 86_400_000} nowMs={now} />);
    expect(screen.getByRole("button", { name: "比較: 昨日" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "比較: 先週" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("保持期間（14 日）の外");
    vi.unstubAllEnvs();
  });

  it("別の理由（棒グラフなど）で比較を使えないときは、すべての比較が押せず、その理由が出る", () => {
    render(<GraphViewControls rangeFrom={Date.now() - 3_600_000} nowMs={Date.now()} compareDisabledReason="棒グラフでは重ねられません" />);
    expect(screen.getByRole("button", { name: "比較: 昨日" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("棒グラフでは重ねられません");
  });
});
