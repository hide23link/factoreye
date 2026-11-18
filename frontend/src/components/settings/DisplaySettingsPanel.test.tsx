import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient as render, screen, waitFor } from "../../test/test-utils";
import { THEME_STORAGE_KEY } from "../../lib/theme";
import { useThemeStore } from "../../store/useThemeStore";
import { useUiStore } from "../../store/useUiStore";
import { DisplaySettingsPanel } from "./DisplaySettingsPanel";

vi.mock("../../lib/api", () => ({
  updateDisplaySettings: vi.fn(),
  fetchDisplaySettings: vi.fn(),
}));

import * as api from "../../lib/api";

afterEach(() => {
  localStorage.clear();
  useThemeStore.setState({ mode: "dark", applied: "dark", saved: false });
  useUiStore.setState({ view: "main" });
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("DisplaySettingsPanel（画面の明るさ）", () => {
  it("初期は「暗い」が選ばれている", () => {
    render(<DisplaySettingsPanel />);
    expect(screen.getByRole("radio", { name: /暗い/ })).toHaveAttribute("aria-checked", "true");
  });

  it("「明るい」を選ぶと、すぐ切り替わり、この端末に保存する", async () => {
    const user = userEvent.setup();
    render(<DisplaySettingsPanel />);

    await user.click(screen.getByRole("radio", { name: /^明るい/ }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("radio", { name: /^明るい/ })).toHaveAttribute("aria-checked", "true");
  });

  it("初期は「この端末だけ」に保存する設定。選んでも、サーバーの全員の初期値は変えない", async () => {
    const user = userEvent.setup();
    render(<DisplaySettingsPanel />);

    expect(screen.getByRole("radio", { name: /この端末だけ/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /^明るい/ }));
    expect(api.updateDisplaySettings).not.toHaveBeenCalled();
  });

  it("「全員の初期値にする」で選ぶと、サーバーに保存し、この端末の選択は消して、その値に従う", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateDisplaySettings).mockResolvedValue({ defaultTheme: "light" });
    // 先にこの端末で「暗い」を選んでいた
    useThemeStore.getState().setMode("dark");
    render(<DisplaySettingsPanel />);

    await user.click(screen.getByRole("radio", { name: /全員の初期値にする/ }));
    await user.click(screen.getByRole("radio", { name: /^明るい/ }));

    await waitFor(() => expect(api.updateDisplaySettings).toHaveBeenCalledWith({ defaultTheme: "light" }));
    await waitFor(() => expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(await screen.findByText("（全員の初期値）")).toBeInTheDocument();
  });

  it("全員の初期値を保存できなかったら、理由を出し、この端末の選択は変えない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateDisplaySettings).mockRejectedValue(new Error("boom"));
    render(<DisplaySettingsPanel />);

    await user.click(screen.getByRole("radio", { name: /全員の初期値にする/ }));
    await user.click(screen.getByRole("radio", { name: /^明るい/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("全員の初期値を保存できませんでした");
    expect(screen.getByRole("radio", { name: /暗い/ })).toHaveAttribute("aria-checked", "true");
  });

  it("端末で選んでいない間は、全員の初期値が使われる。選んだ端末は、その選択が優先される", () => {
    useThemeStore.getState().applyServerDefault("light");
    expect(useThemeStore.getState().mode).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    useThemeStore.getState().setMode("dark");
    useThemeStore.getState().applyServerDefault("light");
    expect(useThemeStore.getState().mode).toBe("dark");
  });

  it("「今の表示」と「計器盤へ」のボタンがある", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ view: "settings" });
    render(<DisplaySettingsPanel />);

    expect(screen.getByText("暗い", { selector: "b" })).toBeInTheDocument();
    expect(screen.getByText(/常に暗い/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "計器盤へ" }));
    expect(useUiStore.getState().view).toBe("main");
  });
});
