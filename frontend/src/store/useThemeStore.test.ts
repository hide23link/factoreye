import { afterEach, describe, expect, it } from "vitest";

import { readThemeMode, SERVER_DEFAULT_STORAGE_KEY, THEME_STORAGE_KEY } from "../lib/theme";
import { useThemeStore } from "./useThemeStore";

const theme = () => document.documentElement.getAttribute("data-theme");

afterEach(() => {
  localStorage.clear();
  useThemeStore.setState({ mode: "dark", applied: "dark", saved: false, kioskLock: false });
  document.documentElement.removeAttribute("data-theme");
});

describe("画面表示モード（壁掛け）の間は、常に暗い", () => {
  it("全員の初期値が明るくても、入っている間は暗く、抜けると選んだ明るさに戻る（mode・saved は変えない）", () => {
    useThemeStore.getState().applyServerDefault("light");
    expect(theme()).toBe("light");

    useThemeStore.getState().setKioskLock(true);
    expect(theme()).toBe("dark");
    expect(useThemeStore.getState()).toMatchObject({ mode: "light", applied: "light", saved: false });

    useThemeStore.getState().setKioskLock(false);
    expect(theme()).toBe("light");
  });

  it("入っている間に明るさを選び直したり、初期値を受け取ったりしても、暗いまま", () => {
    useThemeStore.getState().setKioskLock(true);
    useThemeStore.getState().setMode("light");
    expect(theme()).toBe("dark");
    useThemeStore.getState().applyServerDefault("light");
    expect(theme()).toBe("dark");
    useThemeStore.getState().followServerDefault("light");
    expect(theme()).toBe("dark");
    useThemeStore.getState().setKioskLock(false);
    expect(theme()).toBe("light");
  });
});

describe("全員の初期値の控え（初回のちらつき防止）", () => {
  it("初期値を受け取ると、端末の選択とは別のキーに控える。端末の選択は書き換えない", () => {
    useThemeStore.getState().applyServerDefault("light");
    expect(localStorage.getItem(SERVER_DEFAULT_STORAGE_KEY)).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("端末で選んでいても、控えは更新する（選択を消したあと、最新の初期値で始まるように）", () => {
    useThemeStore.getState().setMode("dark");
    useThemeStore.getState().applyServerDefault("light");
    expect(localStorage.getItem(SERVER_DEFAULT_STORAGE_KEY)).toBe("light");
    expect(useThemeStore.getState().mode).toBe("dark");
  });

  it("起動時の明るさは、端末の選択 → 控え → 暗い の順で決める", () => {
    expect(readThemeMode()).toBe("dark");
    localStorage.setItem(SERVER_DEFAULT_STORAGE_KEY, "light");
    expect(readThemeMode()).toBe("light");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(readThemeMode()).toBe("dark");
    // 知らない値は読み飛ばす
    localStorage.setItem(THEME_STORAGE_KEY, "blue");
    expect(readThemeMode()).toBe("light");
  });
});
