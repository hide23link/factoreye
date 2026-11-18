/**
 * 画面の明るさの状態（選んだ値と、実際の色の組）。選ぶと保存し、<html data-theme> も付け替える。
 * 「端末に合わせる」を選んでいる間は、端末の設定が変わったときに色の組を追いかける（App が startThemeWatch を呼ぶ）。
 *
 * 【誰が使うか】App.tsx（起動時に startThemeWatch と、全員の初期値の反映）、DisplaySettingsPanel（選ぶ）、計器グラフなど（今の色の組を知りたいとき）。
 */
import { create } from "zustand";

import {
  applyTheme,
  clearThemeMode,
  hasSavedThemeMode,
  readThemeMode,
  resolveTheme,
  saveThemeMode,
  systemPrefersLight,
  watchSystemTheme,
  type AppliedTheme,
  type ThemeMode,
} from "../lib/theme";

interface ThemeState {
  mode: ThemeMode;
  applied: AppliedTheme;
  // この端末で選んだ値があるか（あれば、全員の初期値より優先する）
  saved: boolean;
  // この端末で選ぶ（この端末のブラウザに保存する）
  setMode: (mode: ThemeMode) => void;
  // サーバーの「全員の初期値」を使う。この端末で選んだ値があるときは何もしない（保存はしない）
  applyServerDefault: (mode: ThemeMode) => void;
  // 全員の初期値を変えたあと、この端末の選択を消して、その値に従う
  followServerDefault: (mode: ThemeMode) => void;
}

const initialMode = readThemeMode();

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: initialMode,
  applied: resolveTheme(initialMode, systemPrefersLight()),
  saved: hasSavedThemeMode(),
  setMode: (mode) => {
    const applied = resolveTheme(mode, systemPrefersLight());
    saveThemeMode(mode);
    applyTheme(applied);
    set({ mode, applied, saved: true });
  },
  applyServerDefault: (mode) => {
    if (get().saved) return;
    const applied = resolveTheme(mode, systemPrefersLight());
    applyTheme(applied);
    set({ mode, applied });
  },
  followServerDefault: (mode) => {
    clearThemeMode();
    const applied = resolveTheme(mode, systemPrefersLight());
    applyTheme(applied);
    set({ mode, applied, saved: false });
  },
}));

/**
 * 起動時に 1 回呼ぶ。今の色の組を付け、端末の設定の変化を見張る（「端末に合わせる」のときだけ反映）。
 * 戻り値: 見張りをやめる関数（App の useEffect の後片付けで呼ぶ）
 */
export function startThemeWatch(): () => void {
  applyTheme(useThemeStore.getState().applied);
  return watchSystemTheme((prefersLight) => {
    const { mode } = useThemeStore.getState();
    if (mode !== "system") return;
    const applied = resolveTheme(mode, prefersLight);
    applyTheme(applied);
    useThemeStore.setState({ applied });
  });
}
