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
    type: "TrendStack",
    label: "計器グラフ",
    description: "1 センサー 1 行で、目盛りの数字・しきい値・最高・最低・今の値をきちんと読む",
    width: 12,
    height: 10,
    suitedSensor: "measure",
    defaultConfig: {},
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
    type: "TapeGauge",
    label: "計器",
    description: "今の値を四角の数字で出し、目盛りの帯で、しきい値までの余裕・1 時間の変化・15 分後の予測を見る",
    width: 3,
    height: 4,
    suitedSensor: "measure",
    defaultConfig: { decimals: 1 },
  },
  {
    type: "FloorPlan",
    label: "配置図",
    description: "部屋の枠の上に機器の札を置いて、全部の状態を 1 枚で見る（管制塔のように）",
    width: 8,
    height: 9,
    suitedSensor: null,
    defaultConfig: {},
  },
  {
    type: "DeviceTree",
    label: "機器の系統",
    description: "サーバーとつながる機器の受信の様子（最後の受信・注意・受信なし）を系統図で見る",
    width: 12,
    height: 6,
    suitedSensor: null,
    defaultConfig: {},
  },
  {
    type: "Gauge",
    label: "ゲージ",
    description: "範囲の中で、いまの値を針で見る。しきい値の色つき",
    width: 4,
    height: 6,
    suitedSensor: "measure",
    defaultConfig: { decimals: 1 },
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
  {
    type: "TargetStrip",
    label: "達成ストリップ",
    description: "一定の間隔ごとに、目標を満たしたかを緑・赤の帯で見る。受信の確認や、生産の目標に",
    width: 8,
    height: 6,
    suitedSensor: null,
    // 初期値は受信の確認（ハートビート: 60 秒に 1 回、前回の受信から 90 秒以内なら緑）。生産の目標にするときは、判定を「件数」にして、1 時間あたりの目標を決める
    defaultConfig: { stripJudge: "interval", stripMaxGapSeconds: 90, stripBucketMinutes: 1 },
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

/**
 * センサーの種類ごとの、置き方の選択肢（先頭が、「＋」やドラッグで置いたときの既定）。
 * 計測値はグラフ・数値・ゲージ、生産数は生産管理・グラフ・数値、稼働は稼働ステータス・グラフ。
 */
export function widgetChoicesFor(kind: SensorKind): WidgetType[] {
  if (kind === "count") return ["ProductionPlan", "SensorGraph", "StatValue"];
  if (kind === "state") return ["ProductionStatus", "SensorGraph"];
  return ["SensorGraph", "TrendStack", "TapeGauge", "StatValue", "Gauge"];
}

/** センサーを置いたときに作るウィジェットの種類（計測値→グラフ、生産数→生産管理、稼働→稼働ステータス） */
export function defaultWidgetFor(kind: SensorKind): WidgetType {
  return kind === "count" ? "ProductionPlan" : kind === "state" ? "ProductionStatus" : "SensorGraph";
}
