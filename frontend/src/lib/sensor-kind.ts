/**
 * センサーの「種類」を推測する。
 *
 * センサーには種類の項目がない（名前・単位・ID だけ）ため、編集画面の絞り込みや、
 * 「生産管理には生産数のセンサー」といった案内のために、名前と単位から推測する。
 * 推測は案内にだけ使い、ウィジェットに置けるかどうかの制限には使わない（外れても困らないように）。
 *
 * 【誰が使うか】センサー棚（SensorShelf）、ダッシュボードの型（dashboard-templates）、センサーの割り当て（widget-sensors）。
 */
import type { Sensor } from "../types";

/** 計測値（温度・圧力など）、生産数（パルスの数）、稼働（動いている=1／止まっている=0） */
export type SensorKind = "measure" | "count" | "state";

export const SENSOR_KIND_LABEL: Record<SensorKind, string> = {
  measure: "計測値",
  count: "生産数",
  state: "稼働",
};

const STATE_NAME = /稼働|運転|状態|ステータス|run(ning)?\b|status/i;
const COUNT_NAME = /生産|出来高|カウント|パルス|個数|count|pcs|production/i;
// 数える対象の単位。「個」「台」など
const COUNT_UNITS = new Set(["個", "台", "本", "枚", "pcs", "個数", "回", "count"]);

/** 名前と単位から、センサーの種類を推測する。稼働の名前を先に見る（「ライン1 稼働」を生産数と取り違えない） */
export function guessSensorKind(sensor: Pick<Sensor, "name" | "unit">): SensorKind {
  if (STATE_NAME.test(sensor.name)) return "state";
  if (COUNT_NAME.test(sensor.name) || COUNT_UNITS.has(sensor.unit.trim().toLowerCase())) return "count";
  return "measure";
}
