/**
 * グラフ系ウィジェット（センサーグラフ・複数センサー比較）で共通の部品。
 *
 * 【誰が使うか】SensorGraphWidget、MultiSensorComparisonWidget。
 */
import { ReferenceArea, ReferenceLine } from "recharts";

import type { ThresholdBand, ThresholdLine } from "../../lib/graph-config";

/** グラフの区間数（表示の横幅に合わせた本数の目安。API の上限は 1000） */
export const GRAPH_BUCKETS = 500;

const THRESHOLD_COLOR: Record<ThresholdLine["severity"], string> = { warning: "#d97706", critical: "#dc2626" };

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

/** 縦軸の目盛りの文字。しきい値で範囲を広げると端数の多い目盛りになり、軸の幅に入らないため、有効数字 4 桁に丸める */
export function formatYTick(value: number): string {
  return String(Number(value.toPrecision(4)));
}

/** ツールチップの値の文字。長い小数にならないよう有効数字 4 桁に丸め、単位があれば付ける（例: 「83.6 ℃」） */
export function formatTooltipValue(value: unknown, unit: string | undefined): string {
  const number = typeof value === "number" ? value : Number(value);
  const text = Number.isFinite(number) ? formatYTick(number) : String(value);
  return unit ? `${text} ${unit}` : text;
}
