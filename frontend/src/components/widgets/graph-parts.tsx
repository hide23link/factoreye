/**
 * グラフ系ウィジェット（センサーグラフ・複数センサー比較）で共通の部品。
 *
 * 【誰が使うか】SensorGraphWidget、MultiSensorComparisonWidget、GraphLinkView（LinkGraphView の型）。
 */
import { ReferenceArea, ReferenceLine } from "recharts";

import type { ThresholdBand, ThresholdLine } from "../../lib/graph-config";
import type { AlarmBand } from "../../lib/threshold-bands";

/** グラフの区間数（表示の横幅に合わせた本数の目安。API の上限は 1000） */
export const GRAPH_BUCKETS = 500;

/**
 * リンクの画面（グラフ 1 つを 1 画面で見る）が、グラフに渡す表示の指定。
 * 渡すと、ダッシュボードの期間（useTimeRangeStore）を読まず、この範囲で描く。
 * 指の操作はリンクの画面が受けるので、グラフのドラッグ選択・吹き出し・凡例・見出しは出さない（線・色・縦軸は同じ）。
 */
export interface LinkGraphView {
  /** 表示する範囲（ミリ秒）。指を動かしている間は、指に合わせて毎回変わる */
  bounds: { from: number; to: number };
  /**
   * 取得する範囲（ミリ秒）。指を離して少ししてから決まる（指を動かすたびに取り直さないため）。
   * 決まるまでは、前に取れたデータを、表示する範囲の横軸に描く
   */
  fetchBounds: { from: number; to: number };
  /** 今を見ているか（true なら、グラフの設定の間隔で取り直す） */
  live: boolean;
  /** タップした時刻（縦の点線を引く）。無ければ null */
  cursorTime: number | null;
  /** ダッシュボード全体の一覧のとき true。グラフの枠の touch-action を pan-y にして、グラフの上からも縦にスクロールできるようにする */
  scrollY?: boolean;
}

/** グラフの枠の touch-action。リンクの 1 グラフ画面は none（指の操作を全部こちらで受ける）、一覧・ふつうのダッシュボードは pan-y（縦はスクロール） */
export function graphTouchAction(linkView: LinkGraphView | undefined): "none" | "pan-y" {
  return linkView && !linkView.scrollY ? "none" : "pan-y";
}

/** リンクの画面でタップした時刻の、縦の点線。yAxisId は、縦軸が左右 2 つのときに載せる軸 */
export function renderCursorLine(cursorTime: number | null, yAxisId?: string) {
  if (cursorTime === null) return null;
  return <ReferenceLine key="cursor" x={cursorTime} yAxisId={yAxisId} stroke="var(--fe-mut)" strokeDasharray="3 3" ifOverflow="hidden" />;
}

const THRESHOLD_COLOR: Record<ThresholdLine["severity"], string> = { warning: "var(--fe-amb)", critical: "var(--fe-red)" };

/** しきい値の線（軽故障は橙、重故障は赤の破線）。recharts のグラフの子として並べる */
export function renderThresholdLines(lines: ThresholdLine[]) {
  return lines.map((line) => (
    <ReferenceLine
      key={`${line.severity}-${line.label}`}
      y={line.value}
      stroke={THRESHOLD_COLOR[line.severity]}
      strokeDasharray="5 4"
      ifOverflow="extendDomain"
      label={{ value: `${line.label} ${line.value}`, position: "insideTopRight", fontSize: 10, fill: THRESHOLD_COLOR[line.severity] }}
    />
  ));
}

/** しきい値の色の帯（軽故障は橙、重故障は赤）。端のない側は ends（グラフの下端・上端、bandEnds）まで塗る。範囲の外へはみ出す分は、グラフの枠で切る */
export function renderThresholdBands(bands: ThresholdBand[], ends: { low: number; high: number }) {
  return bands.map((band) => (
    <ReferenceArea
      key={`${band.severity}-${band.from ?? "min"}-${band.to ?? "max"}`}
      y1={band.from ?? ends.low}
      y2={band.to ?? ends.high}
      fill={THRESHOLD_COLOR[band.severity]}
      fillOpacity={0.12}
      stroke="none"
      ifOverflow="hidden"
    />
  ));
}

/** 警報の帯 1 つの絵。塗り（透明度 0.16）と上辺の 3px の線。幅は最低 2px（1 点だけの帯でも見えるように） */
function drawAlarmBand({ x, y, width, height }: { x?: number; y?: number; width?: number; height?: number }, color: string) {
  const left = x ?? 0;
  const top = y ?? 0;
  const barWidth = Math.max(2, width ?? 0);
  return (
    <g data-testid="threshold-band" pointerEvents="none">
      <rect x={left} y={top} width={barWidth} height={height ?? 0} style={{ fill: color }} fillOpacity={0.16} />
      <rect x={left} y={top} width={barWidth} height={3} style={{ fill: color }} />
    </g>
  );
}

/**
 * 警報の帯（しきい値を超えた時間の縦の帯。注意＝橙、警報＝赤）。recharts のグラフの子として、線より前に並べる。
 * 左右の端は、表示範囲（from〜to）の中に収める。
 */
export function renderAlarmBands(bands: ReadonlyArray<AlarmBand>, from: number, to: number) {
  return bands.map((band) => (
    <ReferenceArea
      key={`alarm-band-${band.startMs}`}
      x1={Math.max(band.startMs, from)}
      x2={Math.min(band.endMs, to)}
      ifOverflow="hidden"
      shape={(props: { x?: number; y?: number; width?: number; height?: number }) => drawAlarmBand(props, THRESHOLD_COLOR[band.level])}
    />
  ));
}

/** 縦軸の目盛りの文字。しきい値で範囲を広げると端数の多い目盛りになり、軸の幅に入らないため、有効数字 4 桁に丸める */
export function formatYTick(value: number): string {
  // 100 以上は小数 2 桁まで（有効数字 4 桁だと、1028.3 も 1028.5 も「1028」になり、狭い幅の値の目盛りが区別できない）
  return String(Math.abs(value) >= 100 ? Number(value.toFixed(2)) : Number(value.toPrecision(4)));
}

/** ツールチップの値の文字。長い小数にならないよう有効数字 4 桁に丸め、単位があれば付ける（例: 「83.6 ℃」） */
export function formatTooltipValue(value: unknown, unit: string | undefined): string {
  const number = typeof value === "number" ? value : Number(value);
  const text = Number.isFinite(number) ? formatYTick(number) : String(value);
  return unit ? `${text} ${unit}` : text;
}
