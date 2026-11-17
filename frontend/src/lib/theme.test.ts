import { afterEach, describe, expect, it } from "vitest";

import { applyTheme, readThemeMode, resolveTheme, saveThemeMode, THEME_STORAGE_KEY } from "./theme";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("画面の明るさ", () => {
  it("保存が無ければ暗い（初期値）", () => {
    expect(readThemeMode()).toBe("dark");
  });

  it("保存した値を読み戻す。知らない値は暗いに戻す", () => {
    saveThemeMode("light");
    expect(readThemeMode()).toBe("light");
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    expect(readThemeMode()).toBe("dark");
  });

  it("端末に合わせる は、端末の設定で暗い・明るいが決まる", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("色の組は <html data-theme> に付ける", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
