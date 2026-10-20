/**
 * センサー棚（動かせる窓）の位置の保存と、画面内への制限。画面に依存しない関数。
 *
 * - 位置は localStorage に保存し、次に開いたときも同じ場所に出す。localStorage が使えない環境（プライベートモード・
 *   容量超過・保存先なし）でも、例外を握りつぶして、位置を保存しないだけで動く
 * - 見出しが常に画面内に残るよう、位置を制限する。画面が小さくなって画面外になったら、位置を捨てて既定の場所に戻す
 *
 * 【誰が使うか】useEditorStore（読み込み・保存）、EditorShelf（移動の制限）、DashboardView（画面サイズ変更時）。
 */

export interface ShelfPosition {
  x: number;
  y: number;
}

export const SHELF_WIDTH_PX = 272;
/** 見出しの高さ（px）。窓の下端が画面の下に出ても、見出しはこの分だけ画面内に残す */
export const SHELF_HEADER_HEIGHT = 44;
const STORAGE_KEY = "factoreye.sensorShelfPosition";

/** 位置を、窓の幅いっぱいが画面内、見出しが画面内に収まる範囲に制限する */
export function clampShelfPosition(pos: ShelfPosition, viewportWidth: number, viewportHeight: number): ShelfPosition {
  return {
    x: Math.round(Math.min(Math.max(pos.x, 0), Math.max(0, viewportWidth - SHELF_WIDTH_PX))),
    y: Math.round(Math.min(Math.max(pos.y, 0), Math.max(0, viewportHeight - SHELF_HEADER_HEIGHT))),
  };
}

/** 位置が、いまの画面の中に収まっているか（制限しても変わらないか） */
export function isShelfPositionInside(pos: ShelfPosition, viewportWidth: number, viewportHeight: number): boolean {
  const clamped = clampShelfPosition(pos, viewportWidth, viewportHeight);
  return clamped.x === Math.round(pos.x) && clamped.y === Math.round(pos.y);
}

/** 保存した位置を読む。無い・壊れている・いまの画面の外なら null（既定の場所に出す） */
export function loadShelfPosition(viewportWidth: number, viewportHeight: number): ShelfPosition | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { x, y } = parsed as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return isShelfPositionInside({ x, y }, viewportWidth, viewportHeight) ? { x, y } : null;
  } catch {
    return null;
  }
}

/** 位置を保存する。null は「既定の場所に戻す」（保存を消す）。保存できなくても例外にしない */
export function saveShelfPosition(pos: ShelfPosition | null): void {
  try {
    if (pos === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch {
    // 保存できなくても、窓は動かせる（次回は既定の場所に出るだけ）
  }
}
