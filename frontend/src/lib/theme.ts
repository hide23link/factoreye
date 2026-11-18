/**
 * 画面の明るさ（暗い・明るい・端末に合わせる）の読み書き。設定 › 表示 で選ぶ。
 *
 * - 選んだ値は、この端末のブラウザ（localStorage の factoreye.theme）にだけ保存する。ほかの人の画面は変わらない
 * - 端末に選択が無いときだけ、サーバーの「全員の初期値」（GET /api/settings/display）で始まる（store/useThemeStore.ts）
 * - 色そのものは theme.css が持つ。ここは <html data-theme="dark|light"> を付け替えるだけ
 * - 画面を描く前の 1 回目は public/theme-init.js が付ける（同じ読み方。変えるときは両方を直す）
 *
 * 【誰が使うか】store/useThemeStore.ts（選んだ値を画面に配る）、DisplaySettingsPanel（設定の画面）。
 */

export type ThemeMode = "dark" | "light" | "system";
export type AppliedTheme = "dark" | "light";

// 保存の名前。public/theme-init.js と同じ名前にする
export const THEME_STORAGE_KEY = "factoreye.theme";
const MODES: readonly ThemeMode[] = ["dark", "light", "system"];
const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** 保存してある明るさ。保存が無い・読めない・知らない値のときは「暗い」（初期値） */
export function readThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return MODES.find((mode) => mode === saved) ?? "dark";
  } catch {
    return "dark";
  }
}

/** この端末で明るさを選んだことがあるか（保存がある・読める値のとき true） */
export function hasSavedThemeMode(): boolean {
  try {
    return MODES.some((mode) => mode === localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return false;
  }
}

/** この端末の選択を消す（「全員の初期値」に従う状態に戻す）。消せなくても、画面の切り替えは続ける */
export function clearThemeMode(): void {
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // 消せなくても続ける
  }
}

/** 明るさを保存する。保存できない（プライベートモードなど）ときは、今の画面だけ切り替わる */
export function saveThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 保存できなくても、画面の切り替えは続ける
  }
}

/** 端末（パソコン・スマホ）の設定が「ライト」か */
export function systemPrefersLight(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(LIGHT_QUERY).matches;
}

/** 選んだ明るさから、実際に使う色の組を決める（例: system で端末がライト → light） */
export function resolveTheme(mode: ThemeMode, prefersLight: boolean): AppliedTheme {
  if (mode === "system") return prefersLight ? "light" : "dark";
  return mode;
}

/** 画面の色の組を付け替える */
export function applyTheme(theme: AppliedTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * 端末の設定（ダーク／ライト）が変わったら呼ぶ。「端末に合わせる」を選んでいる間だけ使う。
 * 戻り値: 見張りをやめる関数
 */
export function watchSystemTheme(onChange: (prefersLight: boolean) => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(LIGHT_QUERY);
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
