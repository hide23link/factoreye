/**
 * 計器グラフ（1 センサー 1 行で、時間の軸をそろえて縦に並べるグラフ）の計算。
 * 線・目盛り・しきい値・最高・最低・今の値は、すべてここで同じ値から求める（目分量で描かない）。
 *
 * 座標は、どの大きさの枠でも同じ計算で済むよう、割合（0〜100%）で返す。
 * - 横: 表示範囲の始め＝0%、終わり＝100%
 * - 縦: 縦軸の上端＝PLOT_TOP%、下端＝PLOT_BOTTOM%（上下に少し余白を残し、線が枠に貼り付かないようにする）
 *
 * 【誰が使うか】components/widgets/TrendStackWidget.tsx。
 */
import type { DownsampledBucket } from "./api";
import type { Aggregation } from "./graph-config";
import { bucketValue } from "./graph-series";

export const PLOT_TOP = 8;
export const PLOT_BOTTOM = 92;

/** 線の 1 点。time は区間の中央の時刻（ミリ秒） */
export interface TrendPoint {
  time: number;
  value: number;
}

/** 縦軸の目盛り。min〜max を step ごとに区切る（ticks は min と max を含む） */
export interface AxisScale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/** 行の数字（最高・最低は区間の中の本当の最高・最低。平均は件数で重みを付ける） */
export interface TrendStats {
  max: TrendPoint;
  min: TrendPoint;
  average: number;
  last: TrendPoint;
}

/** しきい値（センサーの軽故障・重故障の上限・下限） */
export interface TrendLimit {
  value: number;
  side: "max" | "min";
  severity: "warning" | "critical";
}

// 目盛りの間隔の候補（1・2・2.5・5 の 10 倍ずつ）。読みやすい切りのよい数にするため
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** 区間のデータを、線の点にする（区間の中央の時刻に、区間の値を置く） */
export function toPoints(
  buckets: ReadonlyArray<Pick<DownsampledBucket, "start" | "avg" | "max" | "min">>,
  bucketSeconds: number,
  aggregation: Aggregation,
): TrendPoint[] {
  const half = (bucketSeconds * 1000) / 2;
  return buckets.map((bucket) => ({ time: new Date(bucket.start).getTime() + half, value: bucketValue(bucket, aggregation) }));
}

/**
 * 最高・最低・平均・最後の値。データが無ければ null。
 * 最高・最低は区間の max・min を使う（平均の線だけでは、短い山や谷が丸まって本当の値より小さく見えるため）。
 */
export function trendStats(
  buckets: ReadonlyArray<Pick<DownsampledBucket, "start" | "avg" | "max" | "min" | "count">>,
  bucketSeconds: number,
  points: ReadonlyArray<TrendPoint>,
): TrendStats | null {
  if (buckets.length === 0 || points.length === 0) return null;
  const half = (bucketSeconds * 1000) / 2;
  let max: TrendPoint = { time: 0, value: -Infinity };
  let min: TrendPoint = { time: 0, value: Infinity };
  let sum = 0;
  let count = 0;
  for (const bucket of buckets) {
    const time = new Date(bucket.start).getTime() + half;
    if (bucket.max > max.value) max = { time, value: bucket.max };
    if (bucket.min < min.value) min = { time, value: bucket.min };
    const weight = bucket.count > 0 ? bucket.count : 1;
    sum += bucket.avg * weight;
    count += weight;
  }
  return { max, min, average: sum / count, last: points[points.length - 1] };
}

/**
 * 縦軸の目盛り。データの最低〜最高に、しきい値も入るように広げ、切りのよい数で 3〜maxIntervals 区間に分ける。
 * 例: 18.4〜23.1 ℃としきい値 18・28 → 16〜30 を 2 ごと
 */
export function niceScale(low: number, high: number, maxIntervals = 5): AxisScale {
  let lo = low;
  let hi = high;
  if (hi - lo < 1e-9) {
    // 値が 1 つだけ（平らな線）のときは、上下に少し広げる（0 で割らないため）
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.05 : 1;
    lo -= pad;
    hi += pad;
  }
  const span = hi - lo;
  const rough = span / maxIntervals;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = (NICE_STEPS.find((n) => n * magnitude >= rough) ?? 10) * magnitude;
  // データが目盛りの端に貼り付かないよう、範囲の 3% だけ外側に余白を取ってから、切りのよい数に丸める
  const min = Math.floor((lo - span * 0.03) / step) * step;
  const max = Math.ceil((hi + span * 0.03) / step) * step;
  const ticks: number[] = [];
  for (let value = min; value <= max + step / 1000; value += step) ticks.push(roundTo(value, step));
  return { min: roundTo(min, step), max: roundTo(max, step), step, ticks };
}

/** 目盛りの間隔に合った桁で丸める（0.1 + 0.2 のような小数の誤差を消す） */
function roundTo(value: number, step: number): number {
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(value.toFixed(digits));
}

/** 値を縦の位置（%）にする。上が大きい値 */
export function yPercent(value: number, scale: AxisScale): number {
  const ratio = (scale.max - value) / (scale.max - scale.min);
  return PLOT_TOP + ratio * (PLOT_BOTTOM - PLOT_TOP);
}

/** 時刻を横の位置（%）にする */
export function xPercent(time: number, from: number, to: number): number {
  return ((time - from) / (to - from)) * 100;
}

/**
 * 線の SVG の道筋（viewBox 0 0 1000 100）。区間が抜けている所（受信が無かった間）は線をつながない。
 * gapMs: これより点の間が空いたら、抜けとみなす
 */
export function linePath(points: ReadonlyArray<TrendPoint>, scale: AxisScale, from: number, to: number, gapMs: number): string {
  let path = "";
  let previous: TrendPoint | null = null;
  for (const point of points) {
    const command = previous === null || point.time - previous.time > gapMs ? "M" : "L";
    path += `${command}${(xPercent(point.time, from, to) * 10).toFixed(1)} ${yPercent(point.value, scale).toFixed(2)}`;
    previous = point;
  }
  return path;
}

/**
 * 線を切る（受信が無かったとみなす）点の間の長さ。
 * 機器が送る間隔（点の間の長さの中央値）の 3 倍、または区間 2.5 個分の長いほう。
 * 区間の幅だけで決めると、区間（例: 7 秒）より間をあけて送る機器（例: 1 分ごと）の線が、全部途切れてしまうため。
 */
export function gapThreshold(points: ReadonlyArray<TrendPoint>, bucketMs: number): number {
  const gaps = points.slice(1).map((point, i) => point.time - points[i].time).sort((a, b) => a - b);
  const typical = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0;
  return Math.max(typical * 3, bucketMs * 2.5);
}

/** しきい値を超えている部分だけの道筋（超えている点が続く所をつなぐ）。超えていなければ空 */
export function overPath(
  points: ReadonlyArray<TrendPoint>,
  isOver: (value: number) => boolean,
  scale: AxisScale,
  from: number,
  to: number,
): string {
  let path = "";
  let open = false;
  for (const point of points) {
    if (!isOver(point.value)) {
      open = false;
      continue;
    }
    path += `${open ? "L" : "M"}${(xPercent(point.time, from, to) * 10).toFixed(1)} ${yPercent(point.value, scale).toFixed(2)}`;
    open = true;
  }
  return path;
}

/** センサーのしきい値の一覧（設定されているものだけ） */
export function trendLimits(sensor: {
  thresholdMaxWarning: number | null;
  thresholdMaxCritical: number | null;
  thresholdMinWarning: number | null;
  thresholdMinCritical: number | null;
}): TrendLimit[] {
  const all: Array<[number | null, TrendLimit["side"], TrendLimit["severity"]]> = [
    [sensor.thresholdMaxCritical, "max", "critical"],
    [sensor.thresholdMaxWarning, "max", "warning"],
    [sensor.thresholdMinWarning, "min", "warning"],
    [sensor.thresholdMinCritical, "min", "critical"],
  ];
  return all.flatMap(([value, side, severity]) => (value === null ? [] : [{ value, side, severity }]));
}

/** 値がどの段階か（重故障・軽故障の外か、内か） */
export function levelOf(value: number, limits: ReadonlyArray<TrendLimit>): "critical" | "warning" | "normal" {
  const outside = (limit: TrendLimit) => (limit.side === "max" ? value > limit.value : value < limit.value);
  if (limits.some((limit) => limit.severity === "critical" && outside(limit))) return "critical";
  if (limits.some((limit) => limit.severity === "warning" && outside(limit))) return "warning";
  return "normal";
}

/** 時刻にいちばん近い点。maxDistanceMs より離れていれば null（そこにはデータが無い） */
export function pointNear(points: ReadonlyArray<TrendPoint>, time: number, maxDistanceMs: number): TrendPoint | null {
  let best: TrendPoint | null = null;
  for (const point of points) {
    if (best === null || Math.abs(point.time - time) < Math.abs(best.time - time)) best = point;
  }
  return best !== null && Math.abs(best.time - time) <= maxDistanceMs ? best : null;
}

/**
 * 時間の軸の目盛り（切りのよい時刻）。表示範囲に 4〜8 本ほど入る間隔を選ぶ。
 * 例: 24 時間 → 3 時間ごと（00:00・03:00 …）、1 時間 → 10 分ごと
 */
export function timeTicks(from: number, to: number): number[] {
  const minute = 60_000;
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((m) => m * minute);
  const span = to - from;
  const step = candidates.find((c) => span / c <= 8) ?? candidates[candidates.length - 1];
  // 切りのよい時刻は、この端末の時刻（日本なら JST）でそろえる。getTimezoneOffset は分で、日本は -540
  const offset = new Date(from).getTimezoneOffset() * minute;
  const first = Math.ceil((from - offset) / step) * step + offset;
  const ticks: number[] = [];
  for (let time = first; time <= to; time += step) ticks.push(time);
  return ticks;
}

/** 時間の軸の文字。1 日を超える範囲は日付も付ける（例: 11/18 06:00） */
export function formatTickTime(time: number, spanMs: number): string {
  const date = new Date(time);
  const hhmm = date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return spanMs > 26 * 3_600_000 ? `${date.getMonth() + 1}/${date.getDate()} ${hhmm}` : hhmm;
}

/**
 * 値の文字。小数の桁は、設定（decimals）があればそれ、無ければ目盛りの間隔から決める
 * （間隔 100 以上 → 0 桁（例: 1050 ppm）、1〜50 → 1 桁（例: 96.8 ℃）、0.1〜0.5 → 2 桁、もっと細かい → 3 桁）
 */
export function formatTrendValue(value: number, scale: AxisScale, decimals?: number): string {
  const digits = decimals ?? (scale.step >= 100 ? 0 : scale.step >= 1 ? 1 : scale.step >= 0.1 ? 2 : 3);
  return value.toFixed(digits);
}

/** 目盛りの文字。間隔と同じ桁にする（間隔 2 → 「18」、2.5 → 「17.5」、0.25 → 「0.75」） */
export function formatTick(value: number, scale: AxisScale): string {
  const fraction = String(scale.step).split(".")[1] ?? "";
  return value.toFixed(Math.min(fraction.length, 4));
}

/** 最後のデータから、受信が止まっているとみなすまでの時間（区間 3 つ分、ただし 10 分より短くしない） */
export function staleAfterMs(bucketSeconds: number): number {
  return Math.max(bucketSeconds * 3 * 1000, 10 * 60_000);
}
