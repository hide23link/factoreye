/**
 * ウィジェットの種類の一覧（名前・説明・置いたときの大きさ）。
 * ウィジェット棚、設定パネルの見出し、ダッシュボードの型が同じ情報を使う。
 *
 * 【誰が使うか】WidgetShelf、WidgetSettings、widget-sensors、useWidgetActions。
 */
import type { WidgetConfig, WidgetType } from "../types";
import type { SensorKind } from "./sensor-kind";

export interface WidgetKind {
  type: WidgetType;
  label: string;
  description: string;
  /** 置いたときの大きさ（12 列グリッドの列数・行数） */
  width: number;
  height: number;
  /** 向いているセンサーの種類（案内にだけ使う。ほかの種類も置ける） */
  suitedSensor: SensorKind | null;
  /** 新しく置くときの設定の初期値 */
  defaultConfig: WidgetConfig;
}

/** 棚に並べる順。MultiSensorComparison は、グラフに複数センサーを入れられるようになったため棚には出さない */
export const WIDGET_KINDS: readonly WidgetKind[] = [
  {
    type: "SensorGraph",
    label: "グラフ",
    description: "時間の流れで見る。複数センサーを重ねられます",
    width: 6,
    height: 7,
    suitedSensor: "measure",
    defaultConfig: { graphType: "line" },
  },
  {
    type: "StatValue",
    label: "数値",
    description: "いまの値を大きく表示",
    width: 3,
    height: 4,
    suitedSensor: "measure",
    defaultConfig: { timeRangeHours: 1, decimals: 1 },
  },
  {
    type: "AlarmAlert",
    label: "アラーム一覧",
    description: "発生中のアラームを一覧",
    width: 4,
    height: 7,
    suitedSensor: null,
    defaultConfig: {},
  },
  {
    type: "ProductionStatus",
    label: "稼働ステータス",
    description: "動いているか止まっているかを色で表示",
    width: 4,
    height: 4,
    suitedSensor: "state",
    defaultConfig: { onThreshold: 0 },
  },
  {
    type: "ProductionPlan",
    label: "生産管理",
    description: "目標に対する進み具合と遅れ・見込みを表示",
    width: 6,
    height: 9,
    suitedSensor: "count",
    // 目標は未設定で置く（仮の数字が、実際の目標に見えないように）。設定するまでは、設定を促す表示になる
    defaultConfig: {},
  },
];

/** 旧「複数センサー比較」は棚に無いが、既存のウィジェットとして表示・編集できる */
const LEGACY_LABEL: Partial<Record<WidgetType, string>> = { MultiSensorComparison: "複数センサー比較" };

export function widgetKind(type: WidgetType): WidgetKind | undefined {
  return WIDGET_KINDS.find((k) => k.type === type);
}

export function widgetLabel(type: WidgetType): string {
  return widgetKind(type)?.label ?? LEGACY_LABEL[type] ?? type;
}

/** センサーを置いたときに作るウィジェットの種類（計測値→グラフ、生産数→生産管理、稼働→稼働ステータス） */
export function defaultWidgetFor(kind: SensorKind): WidgetType {
  return kind === "count" ? "ProductionPlan" : kind === "state" ? "ProductionStatus" : "SensorGraph";
}
