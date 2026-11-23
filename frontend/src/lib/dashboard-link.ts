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
import type { Sensor, Widget } from "../types";
import { graphSensorIds } from "./graph-config";
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
  // 達成ストリップ: 説明・目盛り・凡例で約 125px、1 センサー（名前の行と帯）で約 52px（既定の 320px だと、下が空白になる）
  if (widget.type === "TargetStrip") return `${125 + 52 * Math.max(1, graphSensorIds(widget).length)}px`;
  const px = narrowHeightPx(widget);
  return widget.type === "TrendStack" && !preview ? `max(${px}px, ${graphHeightCss(size, headerVar)})` : `${px}px`;
}

/** 「今の値」タイル 1 つ分 */
export interface ValueTile {
  sensorId: string;
  /** タップで移る先のグラフ（最初にそのセンサーを使うグラフのウィジェット ID） */
  widgetId: string;
  /** 名前（グラフの系列名があればそれ、無ければセンサーの名前） */
  name: string;
  unit: string;
}

/** 先頭に出すタイルの数。これを超えるぶんは「ほか N 個の値を見る」で開く */
export const VALUE_TILE_LIMIT = 6;

/** 今の値をすでに出している部品（数値・メーター・計器・計器グラフの今の値の札）。そのセンサーはタイルにしない */
const VALUE_WIDGET_TYPES: ReadonlySet<string> = new Set(["StatValue", "Gauge", "TapeGauge", "TrendStack"]);

/**
 * 一覧の先頭の「今の値」タイル。一覧にあるグラフ（センサーグラフ・複数センサー比較）のセンサーを、並び順に全部。
 * 同じセンサーは 1 つだけ。今の値を出す部品（数値・メーター・計器・計器グラフ）があるセンサーは出さない（重複させない）。
 * タイルは「今の値を出す部品が無いグラフ系のセンサー」だけ。0 個になれば、呼ぶ側はタイル欄ごと出さない。
 */
export function valueTiles(widgets: readonly Widget[], sensors: readonly Sensor[] | undefined): ValueTile[] {
  const shown = new Set(
    widgets.filter((w) => VALUE_WIDGET_TYPES.has(w.type)).flatMap((w) => [...graphSensorIds(w), ...(w.sensorId ? [w.sensorId] : [])]),
  );
  const tiles: ValueTile[] = [];
  for (const widget of listWidgets(widgets).filter(isGraphWidget)) {
    for (const sensorId of graphSensorIds(widget)) {
      if (shown.has(sensorId)) continue;
      shown.add(sensorId);
      const sensor = sensors?.find((s) => s.id === sensorId);
      tiles.push({
        sensorId,
        widgetId: widget.id,
        name: widget.config.seriesNames?.[sensorId]?.trim() || sensor?.name || sensorId,
        unit: sensor?.unit ?? "",
      });
    }
  }
  return tiles;
}
