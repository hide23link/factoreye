/**
 * 設定パネルを出す場所の決め方（画面に依存しない純粋な関数）。
 *
 * 設定パネルはキャンバスの上に重ねて出す（キャンバスの大きさを変えないため）。そのままでは、パネルの下に
 * 隠れたウィジェットを選べない・センサーを置けない。そこで、選んだウィジェットを覆わない側に出す:
 * 1. 右（既定）。ウィジェットが右のパネルの位置に掛からなければ、右
 * 2. 左。センサー棚が開いていれば、その右隣。ウィジェットが左のパネルの位置に掛からなければ、左
 * 3. 下（画面の下に出す横長の窓）。左右どちらでも掛かるとき。呼び出し側が、ウィジェットを窓の上に見える位置までスクロールする
 * 狭い画面（約 640px 未満）は、横にパネルを置く余地がないので、常に下。
 *
 * 【誰が使うか】DashboardView（設定パネルの位置）。
 */

export type PanelPlacement = "right" | "left" | "bottom";

export interface ViewRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const PANEL_WIDTH = 316;
export const SHELF_WIDTH = 272;
/** 窓と画面の縁の間隔 */
export const DRAWER_EDGE = 8;
/** これより狭い画面では、棚とパネルの片方だけを開き、パネルは下に出す */
export const NARROW_VIEWPORT = 640;

export function choosePanelPlacement(input: {
  /** 選んだウィジェットの、画面上の位置。選んでいなければ null */
  widget: ViewRect | null;
  viewportWidth: number;
  viewportHeight: number;
  shelfOpen: boolean;
  /** 窓の上端（画面の上からの距離）。これより上のウィジェットは、窓と重ならない */
  drawerTop: number;
}): PanelPlacement {
  const { widget, viewportWidth, viewportHeight, shelfOpen, drawerTop } = input;
  if (viewportWidth < NARROW_VIEWPORT) return "bottom";
  if (!widget) return "right";
  // 窓の縦の範囲（drawerTop〜画面の下）に入らないウィジェットは、どこに出しても重ならない
  if (widget.bottom <= drawerTop || widget.top >= viewportHeight) return "right";

  const rightEdgeStart = viewportWidth - DRAWER_EDGE - PANEL_WIDTH;
  if (widget.right <= rightEdgeStart) return "right";

  const leftEdgeEnd = DRAWER_EDGE + (shelfOpen ? SHELF_WIDTH + DRAWER_EDGE : 0) + PANEL_WIDTH;
  if (widget.left >= leftEdgeEnd) return "left";

  return "bottom";
}

/** 左に出すときの、窓の左端の位置（センサー棚が開いていれば、その右隣） */
export function leftPanelOffset(shelfOpen: boolean): number {
  return DRAWER_EDGE + (shelfOpen ? SHELF_WIDTH + DRAWER_EDGE : 0);
}
