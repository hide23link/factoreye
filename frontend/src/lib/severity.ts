/**
 * 値を、センサーの軽故障・重故障のしきい値に照らして、正常／軽故障／重故障に分ける。
 * アラーム側（backend app/alarm_engine.py）と同じ優先順位（重故障を先に判定）。
 *
 * 【誰が使うか】StatValueWidget（色分け）、センサー棚（状態の点）。
 */
import type { Sensor } from "../types";

export type Severity = "critical" | "warning" | "normal";

/** しきい値の項目だけを使う（テストで Sensor 全体を作らなくて済むように） */
type SensorThresholds = Pick<
  Sensor,
  "thresholdMaxCritical" | "thresholdMinCritical" | "thresholdMaxWarning" | "thresholdMinWarning"
>;

export function classifySeverity(value: number, sensor: SensorThresholds): Severity {
  if (sensor.thresholdMaxCritical !== null && value > sensor.thresholdMaxCritical) return "critical";
  if (sensor.thresholdMinCritical !== null && value < sensor.thresholdMinCritical) return "critical";
  if (sensor.thresholdMaxWarning !== null && value > sensor.thresholdMaxWarning) return "warning";
  if (sensor.thresholdMinWarning !== null && value < sensor.thresholdMinWarning) return "warning";
  return "normal";
}
