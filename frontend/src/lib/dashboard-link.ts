/**
 * 「ダッシュボード全体を 1 画面で開くリンク」の一覧に、何をどの順で出すかの決まり。
 *
 * - 並び: ダッシュボードの置いた位置の順（上の段から、同じ段なら左から）。縦 1 列に並べる。
 * - 出すもの: グラフ（センサーグラフ・複数センサー比較）、数値・メーターなどの小さい部品、警報の一覧。
 *   平面図・機器の系統図のような重いもの、ダッシュボードの期間で動く計器グラフ・状態の帯・達成ストリップ・生産管理は出さない
 *   （全グラフ共通の期間で動かせない・スマホで読みにくいため）。
 * - 小さい部品（数値・メーター・計器・稼働ステータス）は、縦向きの画面で 2 列に並べる。グラフ・警報は 1 列を使い切る。
 *
 * 画面（React）に依存しない関数だけを置く（テストしやすくするため）。
 *
 * 【誰が使うか】DashboardLinkView（一覧の並べ方）。
 */
import type { Widget, WidgetType } from "../types";
import { isGraphWidget } from "./graph-link";
import { widgetsInReadingOrder } from "./narrow-layout";

/** 一覧に出す小さい部品（縦向きで 2 列に並べる） */
const SMALL_TYPES: ReadonlySet<WidgetType> = new Set(["StatValue", "Gauge", "TapeGauge", "ProductionStatus"]);

/** 一覧に出す、グラフ以外の部品 */
const OTHER_TYPES: ReadonlySet<WidgetType> = new Set(["AlarmAlert"]);

/** 一覧に出す部品か */
export function isListWidget(widget: Pick<Widget, "type">): boolean {
  return isGraphWidget(widget) || SMALL_TYPES.has(widget.type) || OTHER_TYPES.has(widget.type);
}

/** 小さい部品か（縦向きで 2 列に並べる） */
export function isSmallListWidget(widget: Pick<Widget, "type">): boolean {
  return SMALL_TYPES.has(widget.type);
}

/** 一覧に出す部品を、並べる順にして返す（出さない種類は除く） */
export function listWidgets(widgets: readonly Widget[]): Widget[] {
  return widgetsInReadingOrder(widgets).filter(isListWidget);
}

/** 一覧の 1 つの部品の高さ（px）。グラフは 220、小さい部品は種類ごと、警報の一覧は 240 */
export function listHeightPx(widget: Pick<Widget, "type">): number {
  if (isGraphWidget(widget)) return 220;
  if (widget.type === "TapeGauge") return 168;
  if (widget.type === "Gauge") return 150;
  if (widget.type === "AlarmAlert") return 240;
  return 120;
}
