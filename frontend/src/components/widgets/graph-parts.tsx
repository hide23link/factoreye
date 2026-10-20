/**
 * グラフ系ウィジェット（センサーグラフ・複数センサー比較）で共通の部品。
 *
 * 【誰が使うか】SensorGraphWidget、MultiSensorComparisonWidget。
 */
import { ReferenceLine } from "recharts";

import type { ThresholdLine } from "../../lib/graph-config";

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

/** 縦軸の目盛りの文字。しきい値で範囲を広げると端数の多い目盛りになり、軸の幅に入らないため、有効数字 4 桁に丸める */
export function formatYTick(value: number): string {
  return String(Number(value.toPrecision(4)));
}
