/**
 * グラフ系ウィジェット（センサーグラフ・複数センサー比較）の設定の読み書き。
 *
 * センサーの持ち方が2通りある:
 * - センサーグラフ: 先頭のセンサーを widget.sensorId に、全員を config.sensorIds に入れる
 *   （センサー1つだけの古いデータは sensorId のみ。そのまま読める）
 * - 複数センサー比較: config.sensorIds のみ（sensorId は null）
 *
 * 【誰が使うか】SensorGraphWidget、MultiSensorComparisonWidget、GraphSettings、widget-sensors。
 */
import type { Sensor, Widget, WidgetConfig } from "../types";
import { resolveRange, type ResolvedRange, type TimeRange } from "./timeRange";

/** 色の選択肢（クリックで順に切り替える）。先頭の青は、センサーグラフの従来の既定色 */
export const GRAPH_COLORS = ["#2563eb", "#ea580c", "#16a34a", "#9333ea", "#0d9488", "#db2777", "#dc2626", "#4b5563"];

// 複数センサー比較が従来使っていた色。色を選んでいない古いウィジェットの見た目を変えないために残す
const LEGACY_MULTI_PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];

/** グラフに載せるセンサーの ID（表示順） */
export function graphSensorIds(widget: Pick<Widget, "type" | "sensorId" | "config">): string[] {
  const listed = widget.config.sensorIds ?? [];
  if (widget.type === "MultiSensorComparison") return listed;
  if (listed.length > 0) return listed;
  return widget.sensorId ? [widget.sensorId] : [];
}

/** i 番目の線の色。選んだ色 → 従来の単色（color）→ 既定の並び、の順 */
export function graphColor(widget: Pick<Widget, "type" | "config">, index: number): string {
  const chosen = widget.config.colors?.[index];
  if (chosen) return chosen;
  if (widget.type === "MultiSensorComparison") return LEGACY_MULTI_PALETTE[index % LEGACY_MULTI_PALETTE.length];
  if (index === 0 && widget.config.color) return widget.config.color;
  return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

/** 次の色（クリックで切り替える） */
export function nextGraphColor(current: string): string {
  const i = GRAPH_COLORS.indexOf(current);
  return GRAPH_COLORS[(i + 1) % GRAPH_COLORS.length];
}

/**
 * センサーの並びを変えたときの設定の変更分（センサーの ID・色・先頭センサー）。
 * 色は「いま見えている色」を全員分書き出す（並びが変わっても、残ったセンサーの色が入れ替わらないように）。
 */
export function graphSensorPatch(
  widget: Pick<Widget, "type" | "config">,
  nextIds: string[],
  keepColorsOf: number[],
): { sensorId: string | null; config: WidgetConfig } {
  const colors = nextIds.map((_, i) => {
    const from = keepColorsOf[i];
    return from === undefined ? GRAPH_COLORS[i % GRAPH_COLORS.length] : graphColor(widget, from);
  });
  return {
    sensorId: widget.type === "MultiSensorComparison" ? null : (nextIds[0] ?? null),
    config: { ...widget.config, sensorIds: nextIds, colors },
  };
}

/** このウィジェットが使う表示範囲。ウィジェット固有の期間があればそれ、無ければダッシュボード全体 */
export function effectiveRange(widget: Pick<Widget, "config">, dashboardRange: TimeRange): TimeRange {
  const hours = widget.config.rangeHours;
  if (hours !== undefined && hours > 0) return { mode: "relative", durationMs: hours * 60 * 60 * 1000 };
  return dashboardRange;
}

export function effectiveBounds(widget: Pick<Widget, "config">, dashboardRange: TimeRange, now: number): ResolvedRange {
  return resolveRange(effectiveRange(widget, dashboardRange), now);
}

/** グラフに重ねるしきい値の線 */
export interface ThresholdLine {
  value: number;
  severity: "warning" | "critical";
  label: string;
}

/** センサーの軽故障・重故障のしきい値（設定されているものだけ）。上限・下限の両方を返す */
export function thresholdLines(
  sensor: Pick<Sensor, "thresholdMaxWarning" | "thresholdMaxCritical" | "thresholdMinWarning" | "thresholdMinCritical">,
): ThresholdLine[] {
  const candidates: Array<[number | null, ThresholdLine["severity"], string]> = [
    [sensor.thresholdMaxWarning, "warning", "軽故障 上限"],
    [sensor.thresholdMaxCritical, "critical", "重故障 上限"],
    [sensor.thresholdMinWarning, "warning", "軽故障 下限"],
    [sensor.thresholdMinCritical, "critical", "重故障 下限"],
  ];
  return candidates.flatMap(([value, severity, label]) => (value === null ? [] : [{ value, severity, label }]));
}

type AxisBound = number | "auto" | ((dataValue: number) => number);

/**
 * 縦軸の範囲。手動で決めた値を優先し、自動のときは、しきい値の線が見えるように範囲を広げる
 * （線が範囲の外にあると、描かれずに「しきい値が出ない」ように見えるため）。
 */
export function graphYDomain(config: WidgetConfig, thresholdValues: number[]): [AxisBound, AxisBound] {
  const low = Math.min(...thresholdValues);
  const high = Math.max(...thresholdValues);
  const hasThresholds = thresholdValues.length > 0;
  return [
    config.yAxisMin ?? (hasThresholds ? (dataMin: number) => Math.min(dataMin, low) : "auto"),
    config.yAxisMax ?? (hasThresholds ? (dataMax: number) => Math.max(dataMax, high) : "auto"),
  ];
}
