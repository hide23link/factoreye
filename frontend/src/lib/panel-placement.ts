/**
 * 設定パネルを出す場所の決め方（画面に依存しない純粋な関数）。
 *
 * 設定パネルはキャンバスの上に重ねて出す（キャンバスの大きさを変えないため）。そのままでは、パネルの下に
 * 隠れたウィジェットを選べない・センサーを置けない。そこで、選んだウィジェットと、センサー棚（動かせる窓。
 * 開いていればその矩形）の、どちらにも重ならない場所に出す:
 * 1. 右（既定）
 * 2. 左端。または、センサー棚があれば、その右隣
 * 3. 下（画面の下に出す横長の窓）。上のどれも重なるとき。センサー棚が下の帯に掛かるときは、棚を避けて、広い側に出す。
 *    呼び出し側が、ウィジェットを窓の上に見える位置までスクロールする
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

/** パネルを出す場所。left は左端の位置（px）、bottom の right は右端の余白（px） */
export type PanelSlot =
  | { placement: "right" }
  | { placement: "left"; left: number }
  | { placement: "bottom"; left: number; right: number };

/** 下に出すときの窓の高さ（画面の高さに対する割合） */
export const BOTTOM_PANEL_RATIO = 0.45;

function overlaps(a: ViewRect, b: ViewRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function choosePanelSlot(input: {
  /** 選んだウィジェットの、画面上の位置。選んでいなければ null */
  widget: ViewRect | null;
  viewportWidth: number;
  viewportHeight: number;
  /** センサー棚の矩形（画面上）。閉じていれば null */
  shelf: ViewRect | null;
  /** 窓の上端（画面の上からの距離）。これより上のウィジェットは、窓と重ならない */
  drawerTop: number;
  /** 窓の下の余白（狭い画面は、下部ナビの分を含む） */
  bottomGap: number;
}): PanelSlot {
  const { widget, viewportWidth, viewportHeight, shelf, drawerTop, bottomGap } = input;
  if (viewportWidth < NARROW_VIEWPORT) return { placement: "bottom", left: DRAWER_EDGE, right: DRAWER_EDGE };

  // 窓の縦の範囲（drawerTop〜画面の下）に入らないウィジェットは、どこに出しても重ならない
  const relevantWidget = widget && widget.bottom > drawerTop && widget.top < viewportHeight ? widget : null;
  const dockTop = drawerTop;
  const dockBottom = viewportHeight - bottomGap;
  const free = (rect: ViewRect) => !(relevantWidget && overlaps(rect, relevantWidget)) && !(shelf && overlaps(rect, shelf));

  const rightLeft = viewportWidth - DRAWER_EDGE - PANEL_WIDTH;
  if (free({ left: rightLeft, right: rightLeft + PANEL_WIDTH, top: dockTop, bottom: dockBottom })) return { placement: "right" };

  const leftCandidates = [DRAWER_EDGE, ...(shelf ? [Math.round(shelf.right) + DRAWER_EDGE] : [])];
  for (const left of leftCandidates) {
    if (left + PANEL_WIDTH > viewportWidth - DRAWER_EDGE) continue;
    if (free({ left, right: left + PANEL_WIDTH, top: dockTop, bottom: dockBottom })) return { placement: "left", left };
  }

  // 下。棚が下の帯に掛かるときは、棚を避けて、広い側に出す
  const bandTop = viewportHeight - viewportHeight * BOTTOM_PANEL_RATIO - bottomGap;
  if (shelf && shelf.bottom > bandTop && shelf.top < viewportHeight) {
    const rightSpace = viewportWidth - DRAWER_EDGE - (shelf.right + DRAWER_EDGE);
    const leftSpace = shelf.left - DRAWER_EDGE - DRAWER_EDGE;
    if (rightSpace >= leftSpace) return { placement: "bottom", left: Math.round(shelf.right) + DRAWER_EDGE, right: DRAWER_EDGE };
    return { placement: "bottom", left: DRAWER_EDGE, right: viewportWidth - Math.round(shelf.left) + DRAWER_EDGE };
  }
  return { placement: "bottom", left: DRAWER_EDGE, right: DRAWER_EDGE };
}
