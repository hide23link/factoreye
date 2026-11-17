import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { render, screen } from "../../test/test-utils";
import { THEME_STORAGE_KEY } from "../../lib/theme";
import { useThemeStore } from "../../store/useThemeStore";
import { DisplaySettingsPanel } from "./DisplaySettingsPanel";

afterEach(() => {
  localStorage.clear();
  useThemeStore.setState({ mode: "dark", applied: "dark" });
  document.documentElement.removeAttribute("data-theme");
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
});
