/**
 * ウィジェットを置く位置の計算（画面に依存しない純粋な関数）。
 * 位置は backend と同じ「1 始まり」の列・行、12 列グリッド。
 *
 * 【誰が使うか】useWidgetActions（置く位置を決める）、DashboardView（ドロップ位置の点線）。
 */
import type { Widget } from "../types";

export const GRID_COLUMNS = 12;
/** 1行の高さと、ウィジェットどうしの間隔（px）。DashboardView の react-grid-layout の設定と同じ値 */
export const GRID_ROW_HEIGHT = 36;
export const GRID_MARGIN = 12;

export interface GridRect {
  column: number;
  row: number;
  width: number;
  height: number;
}

type Placed = Pick<Widget, "gridColumn" | "gridRow" | "gridWidth" | "gridHeight">;

export function rectOf(widget: Placed): GridRect {
  return { column: widget.gridColumn, row: widget.gridRow, width: widget.gridWidth, height: widget.gridHeight };
}

function overlaps(a: GridRect, b: GridRect): boolean {
  return (
    a.column < b.column + b.width &&
    b.column < a.column + a.width &&
    a.row < b.row + b.height &&
    b.row < a.row + a.height
  );
}

/** ウィジェットの一番下の次の行（左端）。位置を指定せずに追加するときの置き場所 */
export function bottomRow(widgets: Placed[]): number {
  return widgets.reduce((max, w) => Math.max(max, w.gridRow + w.gridHeight), 1);
}

/**
 * 希望の位置に、ほかのウィジェットと重ならないように置く場所を探す。
 * 希望の位置が空いていればそのまま。重なるときは、同じ列のまま下へずらして、最初に空く行にする。
 * 横ははみ出さないよう、列を 1〜(12 − 幅 + 1) に収める。
 */
export function findFreeSpot(widgets: Placed[], width: number, height: number, wantColumn: number, wantRow: number): GridRect {
  const w = Math.min(Math.max(width, 1), GRID_COLUMNS);
  const column = Math.min(Math.max(Math.round(wantColumn), 1), GRID_COLUMNS - w + 1);
  const others = widgets.map(rectOf);
  for (let row = Math.max(Math.round(wantRow), 1); ; row += 1) {
    const candidate = { column, row, width: w, height };
    if (!others.some((o) => overlaps(candidate, o))) return candidate;
  }
}

/** 格子の寸法（react-grid-layout の設定と同じ値）。ドロップ位置の計算に使う */
export interface GridMetrics {
  /** 格子の幅（px） */
  containerWidth: number;
  rowHeight: number;
  margin: number;
}

/** 1 列の幅（px）。react-grid-layout は、外側の余白と列の間を margin で取る */
export function columnWidth(metrics: GridMetrics): number {
  return (metrics.containerWidth - metrics.margin * (GRID_COLUMNS + 1)) / GRID_COLUMNS;
}

/** 格子の左上からの位置（px）を、列・行（1 始まり）にする。範囲外は端に寄せる */
export function pointToCell(metrics: GridMetrics, x: number, y: number): { column: number; row: number } {
  const col = Math.floor((x - metrics.margin) / (columnWidth(metrics) + metrics.margin));
  const row = Math.floor((y - metrics.margin) / (metrics.rowHeight + metrics.margin));
  return {
    column: Math.min(Math.max(col + 1, 1), GRID_COLUMNS),
    row: Math.max(row + 1, 1),
  };
}

/** 列・行の矩形を、格子の左上からの位置と大きさ（px）にする */
export function rectToPixels(metrics: GridMetrics, rect: GridRect) {
  const colW = columnWidth(metrics);
  return {
    left: metrics.margin + (rect.column - 1) * (colW + metrics.margin),
    top: metrics.margin + (rect.row - 1) * (metrics.rowHeight + metrics.margin),
    width: rect.width * colW + (rect.width - 1) * metrics.margin,
    height: rect.height * metrics.rowHeight + (rect.height - 1) * metrics.margin,
  };
}
