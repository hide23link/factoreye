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

/** 線の形の選択肢。値は widget.config.lineShape に保存し、描くときに recharts の曲線の種類へ変える */
export type LineShape = NonNullable<WidgetConfig["lineShape"]>;
export type ThresholdMode = NonNullable<WidgetConfig["thresholdMode"]>;
export type LegendPosition = NonNullable<WidgetConfig["legendPosition"]>;

const CURVE_TYPE: Record<LineShape, "monotone" | "linear" | "stepAfter"> = {
  smooth: "monotone",
  linear: "linear",
  step: "stepAfter",
};
const LINE_SHAPES = Object.keys(CURVE_TYPE) as LineShape[];
const THRESHOLD_MODES: ThresholdMode[] = ["off", "line", "area", "both"];
const LEGEND_POSITIONS: LegendPosition[] = ["bottom", "right", "off"];

/** 見た目の項目が未指定のときの値（従来の見た目と同じ） */
export const DEFAULT_LINE_WIDTH = 1;
export const DEFAULT_FILL_OPACITY = 0.2;
export const MAX_LINE_WIDTH = 6;

/** 範囲外・数値でない値は、既定値にする（保存された設定が壊れていても、グラフを描けるように） */
function finiteWithin(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export interface GraphStyle {
  /** recharts の Line・Area の type */
  curveType: (typeof CURVE_TYPE)[LineShape];
  lineWidth: number;
  fillOpacity: number;
  showPoints: boolean;
  showGrid: boolean;
  showTooltip: boolean;
  legendPosition: LegendPosition;
}

/** 線の形を選んでいないときの形。従来どおり、線グラフはなめらか、面グラフは直線 */
export function defaultLineShape(config: WidgetConfig): LineShape {
  return config.graphType === "area" ? "linear" : "smooth";
}

/** グラフの見た目を、設定から読む。未指定・不正な値は従来の見た目にする */
export function graphStyle(config: WidgetConfig): GraphStyle {
  const lineShape = LINE_SHAPES.includes(config.lineShape as LineShape) ? (config.lineShape as LineShape) : defaultLineShape(config);
  return {
    curveType: CURVE_TYPE[lineShape],
    lineWidth: finiteWithin(config.lineWidth, 0.5, MAX_LINE_WIDTH, DEFAULT_LINE_WIDTH),
    fillOpacity: finiteWithin(config.fillOpacity, 0, 1, DEFAULT_FILL_OPACITY),
    showPoints: config.showPoints === true,
    showGrid: config.showGrid !== false,
    showTooltip: config.showTooltip !== false,
    legendPosition: LEGEND_POSITIONS.includes(config.legendPosition as LegendPosition)
      ? (config.legendPosition as LegendPosition)
      : "bottom",
  };
}

/** しきい値の表示。thresholdMode があればそれ、無ければ従来の showThresholds（true は「線」） */
export function thresholdMode(config: WidgetConfig): ThresholdMode {
  if (THRESHOLD_MODES.includes(config.thresholdMode as ThresholdMode)) return config.thresholdMode as ThresholdMode;
  return config.showThresholds ? "line" : "off";
}

/** 色の帯（しきい値を超えた範囲）。端のない側は null（描くとき、bandEnds で求めたグラフの端にする） */
export interface ThresholdBand {
  from: number | null;
  to: number | null;
  severity: ThresholdLine["severity"];
}

/**
 * センサーの軽故障・重故障の範囲を、色の帯にする。
 * 上側は 軽故障上限〜重故障上限（軽故障）と 重故障上限〜（重故障）、下側は同じく下へ向かって。
 * 片方だけ設定されているときは、その種類の帯だけを作る。
 */
export function thresholdBands(
  sensor: Pick<Sensor, "thresholdMaxWarning" | "thresholdMaxCritical" | "thresholdMinWarning" | "thresholdMinCritical">,
): ThresholdBand[] {
  const bands: ThresholdBand[] = [];
  const { thresholdMaxWarning: maxWarn, thresholdMaxCritical: maxCrit, thresholdMinWarning: minWarn, thresholdMinCritical: minCrit } = sensor;
  if (maxWarn !== null) bands.push({ from: maxWarn, to: maxCrit, severity: "warning" });
  if (maxCrit !== null) bands.push({ from: maxCrit, to: null, severity: "critical" });
  if (minWarn !== null) bands.push({ from: minCrit, to: minWarn, severity: "warning" });
  if (minCrit !== null) bands.push({ from: null, to: minCrit, severity: "critical" });
  return bands;
}

/** しきい値をグラフに重ねるための材料（縦軸の範囲に入れる値・線・帯） */
export interface ThresholdOverlay {
  /** 縦軸の範囲を広げる値。表示がオンなら、帯だけで線を出さないときも、しきい値が見えるように含める */
  axisValues: number[];
  lines: ThresholdLine[];
  bands: ThresholdBand[];
}

/** 表示の設定（thresholdMode）とセンサーから、重ねるものを決める。センサーが無い（複数など）ときは何も重ねない */
export function thresholdOverlay(config: WidgetConfig, sensor: Parameters<typeof thresholdLines>[0] | undefined): ThresholdOverlay {
  const mode = thresholdMode(config);
  if (mode === "off" || !sensor) return { axisValues: [], lines: [], bands: [] };
  const all = thresholdLines(sensor);
  return {
    axisValues: all.map((l) => l.value),
    lines: mode === "line" || mode === "both" ? all : [],
    bands: mode === "area" || mode === "both" ? thresholdBands(sensor) : [],
  };
}

export type Aggregation = NonNullable<WidgetConfig["aggregation"]>;
export type AxisMode = NonNullable<WidgetConfig["axisMode"]>;
export type StackMode = NonNullable<WidgetConfig["stack"]>;

const AGGREGATIONS: Aggregation[] = ["avg", "max", "min"];
const STACK_MODES: StackMode[] = ["none", "normal", "percent"];
/** 自動で取り直す間隔の選択肢（秒）。既定は従来の 30 秒 */
export const REFRESH_SECONDS_OPTIONS = [10, 30, 60, 300] as const;
export const DEFAULT_REFRESH_SECONDS = 30;

export interface GraphDataOptions {
  aggregation: Aggregation;
  refreshMs: number;
  axisMode: AxisMode;
  /** 積み上げ。実際に効くのは、センサー2つ以上の面・棒で、縦軸が実際の値のときだけ（そうでなければ "none"） */
  stack: StackMode;
  /** 積み上げを選べる状態か（設定の画面が、積み上げの欄を出すかの判断に使う） */
  stackable: boolean;
}

/** データの出し方（区間の値・更新間隔・縦軸のモード・積み上げ）を、設定から読む。未指定・不正な値は従来どおりにする */
export function graphDataOptions(config: WidgetConfig, sensorCount: number): GraphDataOptions {
  const seconds = (REFRESH_SECONDS_OPTIONS as readonly number[]).includes(config.refreshSeconds ?? NaN)
    ? (config.refreshSeconds as number)
    : DEFAULT_REFRESH_SECONDS;
  const multiple = sensorCount > 1;
  const axisMode: AxisMode = multiple && config.axisMode === "normalized" ? "normalized" : "shared";
  const stackable = multiple && axisMode === "shared" && (config.graphType === "area" || config.graphType === "bar");
  const stack = STACK_MODES.includes(config.stack as StackMode) ? (config.stack as StackMode) : "none";
  return {
    aggregation: AGGREGATIONS.includes(config.aggregation as Aggregation) ? (config.aggregation as Aggregation) : "avg",
    refreshMs: seconds * 1000,
    axisMode,
    stack: stackable ? stack : "none",
    stackable,
  };
}

export type AxisSide = "left" | "right";

/** 縦軸の左右の割り当て。sides = センサーID → 左か右、leftUnit・rightUnit = その軸に載る単位（混ざるときは " / " でつなぐ）、dual = 右の軸を使うか */
export interface GraphAxisSides {
  sides: Record<string, AxisSide>;
  leftUnit: string;
  rightUnit: string;
  dual: boolean;
}

/**
 * センサーを、縦軸の左右に割り当てる。
 * 既定: 同じ単位のセンサーは同じ軸にまとめる。最初の単位を左、2 番目の単位を右にする。3 種類目以降の単位は左。
 * 設定（config.axisSides）で個別に選んだ左右は、既定より優先する（不正な値は無視する）。
 */
export function graphAxisSides(
  config: WidgetConfig,
  sensorIds: string[],
  unitOf: (sensorId: string) => string | undefined,
): GraphAxisSides {
  const units = [...new Set(sensorIds.map((id) => unitOf(id) ?? ""))];
  const defaultSide = (id: string): AxisSide => (units.indexOf(unitOf(id) ?? "") === 1 ? "right" : "left");
  const sides: Record<string, AxisSide> = {};
  for (const id of sensorIds) {
    const chosen = config.axisSides?.[id];
    sides[id] = chosen === "left" || chosen === "right" ? chosen : defaultSide(id);
  }
  const unitsOn = (side: AxisSide) =>
    [...new Set(sensorIds.filter((id) => sides[id] === side).map((id) => unitOf(id) ?? ""))].filter((u) => u !== "");
  // 単位の文字は、設定で入力したものを優先する（空欄は自動に戻る）
  const custom = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  return {
    sides,
    leftUnit: custom(config.axisUnits?.left) ?? unitsOn("left").join(" / "),
    rightUnit: custom(config.axisUnits?.right) ?? unitsOn("right").join(" / "),
    dual: sensorIds.some((id) => sides[id] === "right"),
  };
}

/** 縦軸の決め方。values = 実際の値（手動の範囲・しきい値込みの自動）、percent = 0〜100% にそろえた、percentStack = 100% 積み上げ（recharts が 0〜1 に換算する） */
export interface GraphYAxisPlan {
  domain: [AxisBound, AxisBound];
  scale: "values" | "percent" | "percentStack";
}

export function graphYAxisPlan(config: WidgetConfig, options: GraphDataOptions, thresholdValues: number[]): GraphYAxisPlan {
  if (options.axisMode === "normalized") return { domain: [0, 100], scale: "percent" };
  if (options.stack === "percent") return { domain: [0, 1], scale: "percentStack" };
  return { domain: graphYDomain(config, thresholdValues), scale: "values" };
}

/**
 * 端のない色の帯を、どこまで塗るか（グラフの縦軸の下端・上端）。
 * recharts の ReferenceArea は、片側を省くと「反対の端まで」塗ってしまい、上へ向かう帯が下へ伸びる（実機で確認）。
 * そのため、端は値で渡す。縦軸の範囲は、手動の範囲があればそれ、無ければ データとしきい値の最小〜最大 になるので、同じ値を使い、少し外へ余らせる。
 */
export function bandEnds(config: WidgetConfig, dataValues: number[], thresholdValues: number[]): { low: number; high: number } {
  const all = [...dataValues, ...thresholdValues];
  if (all.length === 0) return { low: 0, high: 1 };
  const low = config.yAxisMin ?? Math.min(...all);
  const high = config.yAxisMax ?? Math.max(...all);
  const margin = (high - low) * 0.02 || 1;
  return { low: low - margin, high: high + margin };
}
