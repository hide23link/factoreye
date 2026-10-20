/**
 * 新しいダッシュボードの「型」（からっぽ／設備監視／生産管理）。
 * 型を選ぶと、登録済みのセンサーから種類の合うものを選んで、基本のウィジェットを並べる。
 * 合うセンサーが無いウィジェットは、センサー無しで置く（編集モードで後から入れられる）。
 *
 * 【誰が使うか】NewDashboardModal。
 */
import type { Sensor, WidgetConfig, WidgetType } from "../types";
import { widgetKind } from "./widget-catalog";
import { guessSensorKind, type SensorKind } from "./sensor-kind";

export type DashboardTemplateKey = "empty" | "equipment" | "production";

export interface TemplateWidget {
  type: WidgetType;
  sensorId: string | null;
  gridColumn: number;
  gridRow: number;
  gridWidth: number;
  gridHeight: number;
  config: WidgetConfig;
}

export interface DashboardTemplate {
  key: DashboardTemplateKey;
  title: string;
  description: string;
  /** 名前を入力しなかったときの名前 */
  defaultName: string;
  isNew?: boolean;
}

export const DASHBOARD_TEMPLATES: readonly DashboardTemplate[] = [
  { key: "empty", title: "からっぽ", description: "センサーをドラッグして作る", defaultName: "新しいダッシュボード" },
  { key: "equipment", title: "設備監視", description: "グラフ・数値・アラームの基本セット", defaultName: "新しい設備監視" },
  { key: "production", title: "生産管理", description: "目標・進み具合・稼働・時間別の実績", defaultName: "新しい生産管理", isNew: true },
];

/** 種類の合うセンサーを、登録順に取り出す */
function sensorsOfKind(sensors: Sensor[], kind: SensorKind): Sensor[] {
  return sensors.filter((s) => guessSensorKind(s) === kind);
}

function place(type: WidgetType, column: number, row: number, width: number, height: number, sensor: Sensor | undefined, config?: WidgetConfig): TemplateWidget {
  return {
    type,
    sensorId: sensor?.id ?? null,
    gridColumn: column,
    gridRow: row,
    gridWidth: width,
    gridHeight: height,
    config: { ...widgetKind(type)?.defaultConfig, ...config },
  };
}

/** 型に応じたウィジェットの並び。位置は 12 列グリッド（1 始まり） */
export function buildTemplateWidgets(key: DashboardTemplateKey, sensors: Sensor[]): TemplateWidget[] {
  const measures = sensorsOfKind(sensors, "measure");
  const counts = sensorsOfKind(sensors, "count");
  const states = sensorsOfKind(sensors, "state");

  if (key === "equipment") {
    const main = measures[0];
    const sub = measures[1] ?? main;
    return [
      place("SensorGraph", 1, 1, 8, 7, main, { showThresholds: true }),
      place("StatValue", 9, 1, 4, 4, main),
      place("AlarmAlert", 9, 5, 4, 7, undefined),
      place("SensorGraph", 1, 8, 8, 4, sub),
    ];
  }
  if (key === "production") {
    const count = counts[0];
    return [
      place("ProductionPlan", 1, 1, 7, 9, count),
      place("ProductionStatus", 8, 1, 5, 4, states[0]),
      place("SensorGraph", 8, 5, 5, 5, count, { graphType: "bar" }),
    ];
  }
  return [];
}
