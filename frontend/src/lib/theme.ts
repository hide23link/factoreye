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
// サーバーの「全員の初期値」の控え。次に開くとき、取得を待たずに初めの 1 回から正しい明るさで描くため（ちらつき防止）。
// 端末の選択（上の factoreye.theme）があれば、そちらが優先。public/theme-init.js も同じ名前で読む
export const SERVER_DEFAULT_STORAGE_KEY = "factoreye.theme.default";
const MODES: readonly ThemeMode[] = ["dark", "light", "system"];
const LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * 保存してある明るさ。順に、この端末の選択 → サーバーの全員の初期値の控え → 暗い（初期値）。
 * 保存が読めない・知らない値のときは次の候補へ。
 */
export function readThemeMode(): ThemeMode {
  try {
    for (const key of [THEME_STORAGE_KEY, SERVER_DEFAULT_STORAGE_KEY]) {
      const saved = localStorage.getItem(key);
      const mode = MODES.find((m) => m === saved);
      if (mode) return mode;
    }
    return "dark";
  } catch {
    return "dark";
  }
}

/** サーバーの全員の初期値を、控えとして保存する（端末の選択とは別のキー）。保存できなくても続ける */
export function saveServerDefaultTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(SERVER_DEFAULT_STORAGE_KEY, mode);
  } catch {
    // 控えが取れなくても、次に開いたときに少しちらつくだけ
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
