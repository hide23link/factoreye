/**
 * ゲージ（半円のメーター）の目盛りの範囲と、しきい値の色の帯を決める。
 *
 * 【誰が使うか】GaugeWidget。
 */
import type { Sensor, WidgetConfig } from "../types";
import { classifySeverity, type Severity } from "./severity";

type SensorThresholds = Pick<
  Sensor,
  "thresholdMaxCritical" | "thresholdMinCritical" | "thresholdMaxWarning" | "thresholdMinWarning"
>;

export interface GaugeRange {
  min: number;
  max: number;
}

/** 色の帯。from・to は目盛りの全体に対する位置（0〜1） */
export interface GaugeZone {
  severity: Severity;
  from: number;
  to: number;
}

function thresholdValues(sensor: SensorThresholds): number[] {
  return [
    sensor.thresholdMinCritical,
    sensor.thresholdMinWarning,
    sensor.thresholdMaxWarning,
    sensor.thresholdMaxCritical,
  ].filter((v): v is number => v !== null);
}

/** 値の大きさに合う、切りのよい上限（1・2・5 × 10 のべき乗）。例: 37 → 50、92 → 100 */
function niceCeiling(value: number): number {
  if (value <= 0) return 100;
  const power = 10 ** Math.floor(Math.log10(value));
  const unit = [1, 2, 5, 10].find((u) => u * power >= value) ?? 10;
  return unit * power;
}

/**
 * 目盛りの範囲。手動（gaugeMin・gaugeMax が両方あり、min < max）ならそれ。
 * 自動のときは、しきい値が収まるように決める（0 以上のしきい値なら 0 から、最大のしきい値の少し先まで）。
 * しきい値が無ければ、現在値に合う切りのよい範囲。どちらも、現在値が範囲の外なら、針が見えるよう広げる。
 */
export function gaugeRange(sensor: SensorThresholds, config: WidgetConfig, latest: number | undefined): GaugeRange {
  const { gaugeMin, gaugeMax } = config;
  if (gaugeMin !== undefined && gaugeMax !== undefined && Number.isFinite(gaugeMin) && Number.isFinite(gaugeMax) && gaugeMin < gaugeMax) {
    return { min: gaugeMin, max: gaugeMax };
  }
  const values = thresholdValues(sensor);
  let min: number;
  let max: number;
  if (values.length > 0) {
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = high - low;
    const pad = Math.max(span, Math.abs(high) * 0.25, 1);
    min = low >= 0 ? 0 : low - pad;
    max = high + pad;
  } else {
    // 現在値が負なら、0 を上端にして下へ広げる（例: -37 → -50〜0）
    const negative = latest !== undefined && latest < 0;
    min = negative ? -niceCeiling(-latest * 1.25) : 0;
    max = negative ? 0 : niceCeiling(Math.max(latest ?? 0, 0) * 1.25);
  }
  if (latest !== undefined) {
    if (latest > max) max = latest + (max - min) * 0.1;
    if (latest < min) min = latest - (max - min) * 0.1;
  }
  return { min, max };
}

/** 値を、目盛りの位置（0〜1）にする。範囲の外は端に寄せる */
export function gaugeFraction(value: number, range: GaugeRange): number {
  return Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
}

/** しきい値の色の帯。しきい値で区切り、隣り合う同じ重さの帯は1つにまとめる。しきい値が無ければ、全体が正常 */
export function gaugeZones(sensor: SensorThresholds, range: GaugeRange): GaugeZone[] {
  const cuts = [...new Set(thresholdValues(sensor))].filter((v) => v > range.min && v < range.max).sort((a, b) => a - b);
  const edges = [range.min, ...cuts, range.max];
  const zones: GaugeZone[] = [];
  edges.slice(0, -1).forEach((left, i) => {
    const right = edges[i + 1];
    const severity = classifySeverity((left + right) / 2, sensor);
    const from = gaugeFraction(left, range);
    const to = gaugeFraction(right, range);
    const previous = zones[zones.length - 1];
    if (previous?.severity === severity) previous.to = to;
    else zones.push({ severity, from, to });
  });
  return zones;
}

// ── 半円の描き方（GaugeWidget の SVG。viewBox は 200 × 120、中心 (100, 100)、半径 80） ──
export const GAUGE_CENTER_X = 100;
export const GAUGE_CENTER_Y = 100;
export const GAUGE_RADIUS = 80;

/** 目盛りの位置（0〜1）を、半円の上の点にする（0 = 左端、1 = 右端、0.5 = 真上） */
export function gaugePointAt(fraction: number, radius: number): [number, number] {
  const angle = Math.PI * (1 - fraction);
  return [GAUGE_CENTER_X + radius * Math.cos(angle), GAUGE_CENTER_Y - radius * Math.sin(angle)];
}

/** 半円の弧（from〜to の位置）の SVG パス。弧は最大でも半円（180°）なので、large-arc は 0、時計回り（左から右へ、上を通る） */
export function gaugeArcPath(from: number, to: number): string {
  const [x0, y0] = gaugePointAt(from, GAUGE_RADIUS);
  const [x1, y1] = gaugePointAt(to, GAUGE_RADIUS);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${GAUGE_RADIUS},${GAUGE_RADIUS} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}
