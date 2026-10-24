/**
 * センサーのしきい値を、横一列の色の帯（正常・軽故障・重故障）に分ける。センサー一覧の「しきい値バー」の元データ。
 *
 * 【誰が使うか】ThresholdBar。
 */
import type { Sensor } from "../types";
import { classifySeverity, type Severity } from "./severity";

type SensorThresholds = Pick<
  Sensor,
  "thresholdMaxCritical" | "thresholdMinCritical" | "thresholdMaxWarning" | "thresholdMinWarning"
>;

export interface ThresholdZone {
  severity: Severity;
  /** 帯の幅（全体に対する割合、0〜1） */
  share: number;
  /** 帯の左端・右端の値。端（しきい値の外側）は null */
  from: number | null;
  to: number | null;
}

/**
 * しきい値が1つも無いときは null。あるときは、小さい順に並べたしきい値で区切った帯を返す。
 * 両端（しきい値の外側）は、しきい値の幅と同じ長さ（幅が 0 のときは 1）を足して、見える長さにする（正常側が極端に短く見えて、軽故障の範囲が広いと誤解されないように）。
 * 隣り合う同じ重さの帯は1つにまとめる（軽故障と重故障のしきい値が逆転しているときなど）。
 */
export function thresholdZones(sensor: SensorThresholds): ThresholdZone[] | null {
  const values = [
    sensor.thresholdMinCritical,
    sensor.thresholdMinWarning,
    sensor.thresholdMaxWarning,
    sensor.thresholdMaxCritical,
  ].filter((v): v is number => v !== null);
  if (values.length === 0) return null;

  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0];
  const pad = span === 0 ? 1 : span;
  const edges = [sorted[0] - pad, ...sorted, sorted[sorted.length - 1] + pad];
  const total = edges[edges.length - 1] - edges[0];

  const zones: ThresholdZone[] = [];
  edges.slice(0, -1).forEach((left, i) => {
    const right = edges[i + 1];
    const severity = classifySeverity((left + right) / 2, sensor);
    const share = (right - left) / total;
    const to = i === edges.length - 2 ? null : right;
    const previous = zones[zones.length - 1];
    if (previous?.severity === severity) {
      previous.share += share;
      previous.to = to;
    } else {
      zones.push({ severity, share, from: i === 0 ? null : left, to });
    }
  });
  return zones;
}
