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
  if (widget.type === "DeviceTree") return 200;
  if (widget.type === "TrendStack") return 56 + 96 * Math.max(1, graphSensorIds(widget).length);
  // 状態の帯: スマホでは 1 行が「名前・帯・稼働率」の 3 段で約 68px。ほかに目盛り・凡例・注記など約 140px（実機で、4 行 = 約 393px を測った）
  if (widget.type === "StateTimeline") return 140 + 68 * Math.max(1, graphSensorIds(widget).length);
  return NARROW_DEFAULT_HEIGHT;
}


/** スマホの縦 1 列の、1 つのまとまり。pair が true のときは、2 列に並べる（計器が続くとき） */
export interface NarrowGroup {
  pair: boolean;
  widgets: Widget[];
}

/**
 * 並んだウィジェットを、スマホの表示のまとまりに分ける。計器（TapeGauge）が 2 つ続くところは、2 列に並べる。
 * 1 つだけ（前後が計器でない）の計器は、1 列のまま。奇数個のときは、最後の 1 つが 1 列になる。
 * 例: [計器, 計器, 計器グラフ, 計器] → [{ pair: true, [計器, 計器] }, { pair: false, [計器グラフ] }, { pair: false, [計器] }]
 */
export function groupNarrowWidgets(widgets: readonly Widget[]): NarrowGroup[] {
  const groups: NarrowGroup[] = [];
  for (let i = 0; i < widgets.length; i++) {
    const widget = widgets[i];
    const next = widgets[i + 1];
    if (widget.type === "TapeGauge" && next?.type === "TapeGauge") {
      groups.push({ pair: true, widgets: [widget, next] });
      i++;
    } else {
      groups.push({ pair: false, widgets: [widget] });
    }
  }
  return groups;
}
