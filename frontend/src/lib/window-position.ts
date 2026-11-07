/**
 * 動かせる窓（センサー棚・設定パネル）の位置と大きさの保存と、画面内への制限。画面に依存しない関数。
 *
 * - 大きさ（幅・高さ）も窓ごとに保存する。最小は既定の幅（棚 272・パネル 316）と高さ 160、最大は画面内に収まる範囲。
 *   画面が小さくなって収まらないときは、使うたびに収まる大きさへ丸める（保存した値は残す）。大きさは、位置を持つ（動かした・
 *   大きさを変えた）窓にだけある。「もとの位置・大きさ」で、位置と一緒に消える
 * - 位置は窓ごとに localStorage に保存し、次に開いたときも同じ場所に出す。localStorage が使えない環境
 *   （プライベートモード・容量超過・保存先なし）でも、例外を握りつぶして、位置を保存しないだけで動く
 * - 見出しが常に画面内に残るよう、位置を制限する。画面が小さくなって画面外になったら、表示だけ既定の場所に戻す
 *   （保存した位置は残す。画面が元に戻れば、次の編集で復元される）
 *
 * 【誰が使うか】useEditorStore（読み込み・保存）、useMovableWindow（移動の制限）、DashboardView（画面サイズ変更時）。
 */

export interface WindowPosition {
  x: number;
  y: number;
}

/** 動かせる窓の種類 */
export type MovableWindow = "shelf" | "panel";

/** 窓の幅（px）。画面内に収める制限に使う */
export const WINDOW_WIDTH: Record<MovableWindow, number> = { shelf: 272, panel: 316 };
/** 見出しの高さ（px）。窓の下端が画面の下に出ても、見出しはこの分だけ画面内に残す */
export const WINDOW_HEADER_HEIGHT = 44;
const STORAGE_KEY: Record<MovableWindow, string> = {
  shelf: "factoreye.sensorShelfPosition",
  panel: "factoreye.settingsPanelPosition",
};

/** 窓の大きさ（px） */
export interface WindowSize {
  width: number;
  height: number;
}

/** 窓の高さの最小（px） */
export const MIN_WINDOW_HEIGHT = 160;
/** 窓と画面の縁の最小の間隔（px）。大きさの最大を決めるのに使う */
const SCREEN_EDGE = 8;

const SIZE_STORAGE_KEY: Record<MovableWindow, string> = {
  shelf: "factoreye.sensorShelfSize",
  panel: "factoreye.settingsPanelSize",
};

/**
 * 窓の大きさを、最小〜最大の範囲に収める。最大は、位置から画面の右・下の縁（間隔 8px）まで。
 * 画面が最小より狭いときは、最小を優先する（それ以上は小さくしない）。
 */
export function clampWindowSize(
  kind: MovableWindow,
  size: WindowSize,
  pos: WindowPosition,
  viewportWidth: number,
  viewportHeight: number,
): WindowSize {
  const maxWidth = Math.max(WINDOW_WIDTH[kind], viewportWidth - pos.x - SCREEN_EDGE);
  const maxHeight = Math.max(MIN_WINDOW_HEIGHT, viewportHeight - pos.y - SCREEN_EDGE);
  return {
    width: Math.round(Math.min(Math.max(size.width, WINDOW_WIDTH[kind]), maxWidth)),
    height: Math.round(Math.min(Math.max(size.height, MIN_WINDOW_HEIGHT), maxHeight)),
  };
}

/** 保存した大きさを読む。無い・壊れている・最小より小さいなら null（既定の大きさ）。画面に収まるかは、使うときに丸める */
export function loadWindowSize(kind: MovableWindow): WindowSize | null {
  try {
    const raw = window.localStorage.getItem(SIZE_STORAGE_KEY[kind]);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { width, height } = parsed as Record<string, unknown>;
    if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width < WINDOW_WIDTH[kind] || height < MIN_WINDOW_HEIGHT) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** 大きさを保存する。null は「既定に戻す」（保存を消す）。保存できなくても例外にしない */
export function saveWindowSize(kind: MovableWindow, size: WindowSize | null): void {
  try {
    if (size === null) window.localStorage.removeItem(SIZE_STORAGE_KEY[kind]);
    else window.localStorage.setItem(SIZE_STORAGE_KEY[kind], JSON.stringify(size));
  } catch {
    // 保存できなくても、窓の大きさは変えられる（次回は既定の大きさに出るだけ）
  }
}

/**
 * 位置を、窓の幅いっぱいが横に、見出しが縦に、画面内へ収まる範囲に制限する。
 * width = 利用者が変えた窓の幅（省略は既定の幅）。広げた窓は、右の縁から 8px の間隔を残して止める
 * （止めずに動かすと、大きさの制限で窓が既定の幅まで縮んでしまうため）
 */
export function clampWindowPosition(
  kind: MovableWindow,
  pos: WindowPosition,
  viewportWidth: number,
  viewportHeight: number,
  width?: number,
): WindowPosition {
  const span = width === undefined ? WINDOW_WIDTH[kind] : width + SCREEN_EDGE;
  return {
    x: Math.round(Math.min(Math.max(pos.x, 0), Math.max(0, viewportWidth - span))),
    y: Math.round(Math.min(Math.max(pos.y, 0), Math.max(0, viewportHeight - WINDOW_HEADER_HEIGHT))),
  };
}

/** 位置が、いまの画面の中に収まっているか（制限しても変わらないか） */
export function isWindowPositionInside(
  kind: MovableWindow,
  pos: WindowPosition,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  const clamped = clampWindowPosition(kind, pos, viewportWidth, viewportHeight);
  return clamped.x === Math.round(pos.x) && clamped.y === Math.round(pos.y);
}

/** 保存した位置を読む。無い・壊れている・いまの画面の外なら null（既定の場所に出す） */
export function loadWindowPosition(kind: MovableWindow, viewportWidth: number, viewportHeight: number): WindowPosition | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY[kind]);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { x, y } = parsed as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return isWindowPositionInside(kind, { x, y }, viewportWidth, viewportHeight) ? { x, y } : null;
  } catch {
    return null;
  }
}

/** 位置を保存する。null は「既定の場所に戻す」（保存を消す）。保存できなくても例外にしない */
export function saveWindowPosition(kind: MovableWindow, pos: WindowPosition | null): void {
  try {
    if (pos === null) window.localStorage.removeItem(STORAGE_KEY[kind]);
    else window.localStorage.setItem(STORAGE_KEY[kind], JSON.stringify(pos));
  } catch {
    // 保存できなくても、窓は動かせる（次回は既定の場所に出るだけ）
  }
}
