/**
 * 動かせる窓（センサー棚・設定パネル）の位置の保存と、画面内への制限。画面に依存しない関数。
 *
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

/** 位置を、窓の幅いっぱいが横に、見出しが縦に、画面内へ収まる範囲に制限する */
export function clampWindowPosition(
  kind: MovableWindow,
  pos: WindowPosition,
  viewportWidth: number,
  viewportHeight: number,
): WindowPosition {
  return {
    x: Math.round(Math.min(Math.max(pos.x, 0), Math.max(0, viewportWidth - WINDOW_WIDTH[kind]))),
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
