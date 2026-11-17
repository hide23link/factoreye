/**
 * スマホ（狭い画面）の縦 1 列での、ウィジェットの並び順と高さ。
 * 狭い画面は格子をやめて、ウィジェットを縦に積む。サーバーが返す順（作った順）ではなく、置いた位置の順に積み、
 * 種類によって高さを変える（計器は低く、計器グラフは行の数に合わせる）。
 *
 * 【誰が使うか】components/DashboardView.tsx（isNarrow のとき）。
 */
import type { Widget } from "../types";
import { graphSensorIds } from "./graph-config";

// スマホの縦 1 列で、ウィジェットに与える高さ（px）の基準。種類によっては、中身に合わせて変える（narrowHeightPx）
const NARROW_DEFAULT_HEIGHT = 320;

/** スマホで並べる順。置いた位置の順（上の段から、同じ段なら左から）。サーバーが返す順（作った順）にしない */
export function widgetsInReadingOrder(widgets: readonly Widget[]): Widget[] {
  return [...widgets].sort((a, b) => a.gridRow - b.gridRow || a.gridColumn - b.gridColumn);
}

/** スマホの縦 1 列での、ウィジェットの高さ。計器は低く、計器グラフは行の数に合わせる（1 行 96px + 見出しなど 56px） */
export function narrowHeightPx(widget: Widget): number {
  if (widget.type === "TapeGauge") return 168;
  if (widget.type === "TrendStack") return 56 + 96 * Math.max(1, graphSensorIds(widget).length);
  return NARROW_DEFAULT_HEIGHT;
}

