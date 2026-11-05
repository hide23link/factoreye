/**
 * センサーの「種類」を推測する。
 *
 * センサーには種類の項目がない（名前・単位・ID だけ）ため、編集画面の絞り込みや、
 * 「生産管理には生産数のセンサー」といった案内のために、名前と単位から推測する。
 * 推測は案内にだけ使い、ウィジェットに置けるかどうかの制限には使わない（外れても困らないように）。
 *
 * 【誰が使うか】センサー棚（SensorShelf）、センサーの割り当て（widget-sensors）。
 */
import type { Sensor } from "../types";

/** 計測値（温度・圧力など）、生産数（パルスの数）、稼働（動いている=1／止まっている=0） */
export type SensorKind = "measure" | "count" | "state";

export const SENSOR_KIND_LABEL: Record<SensorKind, string> = {
  measure: "計測値",
  count: "生産数",
  state: "稼働",
};

const STATE_NAME = /稼働|運転|状態|ステータス|\brun(ning)?\b|\bstatus\b/i;
const COUNT_NAME = /生産|出来高|カウント|パルス|個数|\bcount\b|\bpcs\b|\bproduction\b/i;
// 「稼働時間」「稼働率」「運転電流」のように、稼働・生産という語を含んでいても、別の量を表す名前
const OTHER_QUANTITY = /時間|率|電流|電圧|電力|温度|圧力|速度|回転|負荷|\b(time|rate|current|voltage|power|speed)\b/i;
// 数える対象の単位。「個」「台」など
const COUNT_UNITS = new Set(["個", "台", "本", "枚", "pcs", "個数", "回", "count"]);
// 稼働（動いている=1／止まっている=0）の単位。空か、0/1 を表すもの
const STATE_UNITS = new Set(["", "0/1", "on/off", "onoff", "bool"]);

/**
 * 名前と単位から、センサーの種類を推測する。外れても困らないよう、迷うときは「計測値」にする。
 * - 稼働: 名前が稼働・運転などで、単位が空か 0/1。別の量を表す名前（稼働時間・稼働率・運転電流など）は除く
 * - 生産数: 単位が個・台など、または、名前が生産・出来高などで単位が空。別の量を表す名前は除く
 */
export function guessSensorKind(sensor: Pick<Sensor, "name" | "unit">): SensorKind {
  const unit = sensor.unit.trim().toLowerCase();
  const nameIsOtherQuantity = OTHER_QUANTITY.test(sensor.name);
  if (!nameIsOtherQuantity && STATE_NAME.test(sensor.name) && STATE_UNITS.has(unit)) return "state";
  if (COUNT_UNITS.has(unit) && !nameIsOtherQuantity) return "count";
  if (!nameIsOtherQuantity && COUNT_NAME.test(sensor.name) && unit === "") return "count";
  return "measure";
}
