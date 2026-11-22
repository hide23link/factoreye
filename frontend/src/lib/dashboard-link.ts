/**
 * 「ダッシュボード全体を 1 画面で開くリンク」の一覧に、何をどの順で出すかと、カードの高さの決まり。
 *
 * - 並び: ダッシュボードの置いた位置の順（上の段から、同じ段なら左から）。縦 1 列に並べる。
 * - 出すもの: ダッシュボードのすべての部品。期間で動く部品（計器グラフ・状態の帯・達成ストリップ）は、
 *   リンクの共通期間で動かす（hooks/useWidgetRange.ts の LinkRangeContext で、期間を差し替える）。
 * - 小さい部品（数値・メーター・計器・稼働ステータス）は、縦向きの画面で 2 列に並べる。それ以外は 1 列を使い切る。
 * - 高さ: グラフ（センサーグラフ・複数センサー比較）は、画面の高さに合わせて「半分」（2 枚が縦に収まる）か「全画面」（帯を除く画面いっぱい）。
 *   中身で高さが決まる部品（計器グラフ・状態の帯・平面図など）は、narrowHeightPx の高さ。ただしグラフ以上の高さにする（計器グラフ）。
 *
 * 画面（React）に依存しない関数だけを置く（テストしやすくするため）。
 *
 * 【誰が使うか】DashboardLinkView（一覧の並べ方・カードの高さ）。
 */
import type { Widget } from "../types";
import { isGraphWidget } from "./graph-link";
import { narrowHeightPx, widgetsInReadingOrder } from "./narrow-layout";

/** グラフのカードの大きさ。half = 画面の半分（既定）、full = 帯を除く画面いっぱい */
export type GraphSize = "half" | "full";

/** グラフのカードの最低の高さ（px） */
export const GRAPH_MIN_HEIGHT_PX = 240;

/** 縦向きで 2 列に並べる小さい部品 */
const SMALL_TYPES: ReadonlySet<string> = new Set(["StatValue", "Gauge", "TapeGauge", "ProductionStatus"]);

/** 小さい部品か（縦向きで 2 列に並べる） */
export function isSmallListWidget(widget: Pick<Widget, "type">): boolean {
  return SMALL_TYPES.has(widget.type);
}

/** 一覧に出す部品を、並べる順にして返す（すべての種類を出す） */
export function listWidgets(widgets: readonly Widget[]): Widget[] {
  return widgetsInReadingOrder(widgets);
}

/**
 * グラフのカードの高さ（CSS の値）。headerVar = 固定の帯の高さを入れた CSS 変数（例: "--hdr"）。
 * half: 表示領域の約半分（帯と余白を引いた残りの 1/2。2 枚が縦に収まる）、full: 帯を除く表示領域いっぱい。最低 240px。
 */
export function graphHeightCss(size: GraphSize, headerVar: string): string {
  const free = `(100dvh - var(${headerVar}) - 1.5rem)`;
  return size === "full" ? `max(${GRAPH_MIN_HEIGHT_PX}px, calc${free})` : `max(${GRAPH_MIN_HEIGHT_PX}px, calc(${free} / 2))`;
}

/**
 * 一覧の 1 つの部品の高さ（CSS の値）。preview = 見本（小さい固定の高さ）。
 * グラフは graphHeightCss、小さい部品は種類ごとの固定、
 * それ以外（警報の一覧を含む）は narrowHeightPx（スマホの縦 1 列と同じ高さ）。計器グラフはグラフ以上の高さにする。
 */
export function listHeightCss(widget: Widget, size: GraphSize, headerVar: string, preview: boolean): string {
  if (isGraphWidget(widget)) return preview ? "220px" : graphHeightCss(size, headerVar);
  if (widget.type === "TapeGauge") return "168px";
  if (widget.type === "Gauge") return "150px";
  if (isSmallListWidget(widget)) return "120px";
  const px = narrowHeightPx(widget);
  return widget.type === "TrendStack" && !preview ? `max(${px}px, ${graphHeightCss(size, headerVar)})` : `${px}px`;
}
