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
 * 縦軸の目盛り。データの最低〜最高に、しきい値も入るように広げ、切りのよい数で maxIntervals 区間以内に分ける。
 * 例: 18.4〜23.1 ℃としきい値 18・28 → 16〜30 を 2 ごと
 */
export function niceScale(low: number, high: number, maxIntervals = 7): AxisScale {
  let lo = low;
  let hi = high;
  if (hi - lo < 1e-9) {
    // 値が 1 つだけ（平らな線）のときは、上下に少し広げる（0 で割らないため）
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.05 : 1;
    lo -= pad;
    hi += pad;
  }
  const span = hi - lo;
  const magnitude = 10 ** Math.floor(Math.log10(span / maxIntervals));
  // 候補の間隔を小さい順に試し、外側に余白を取って丸めても maxIntervals 区間に収まる最初のものを使う
  const candidates = [...NICE_STEPS, 20, 25, 50, 100].map((n) => n * magnitude);
  for (const step of candidates) {
    const min = Math.floor((lo - span * 0.03) / step) * step;
    const max = Math.ceil((hi + span * 0.03) / step) * step;
    if (Math.round((max - min) / step) <= maxIntervals) return buildScale(min, max, step);
  }
  const step = candidates[candidates.length - 1];
  return buildScale(Math.floor(lo / step) * step, Math.ceil(hi / step) * step, step);
}

/** 目盛りの一覧を作る（丸めの誤差を消して） */
function buildScale(min: number, max: number, step: number): AxisScale {
  const count = Math.round((max - min) / step);
  const ticks = Array.from({ length: count + 1 }, (_, i) => roundTo(min + i * step, step));
  return { min: roundTo(min, step), max: roundTo(max, step), step, ticks };
}

/** 間隔を書くのに要る小数の桁（2 → 0、2.5 → 1、0.25 → 2、0.00005 → 5） */
export function decimalsOf(step: number): number {
  for (let digits = 0; digits < 12; digits += 1) {
    const scaled = step * 10 ** digits;
    // 整数（1 以上）になった桁で止める。誤差は大きさに比べて判定する（とても小さな間隔でも 0 桁にしない）
    if (Math.round(scaled) >= 1 && Math.abs(scaled - Math.round(scaled)) < 1e-6 * scaled) return digits;
  }
  return 12;
}

/** 目盛りの間隔に合った桁で丸める（0.1 + 0.2 のような小数の誤差を消す） */
function roundTo(value: number, step: number): number {
  return Number(value.toFixed(decimalsOf(step)));
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
export function timeTicks(from: number, to: number, maxTicks = 8): number[] {
  const minute = 60_000;
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((m) => m * minute);
  const span = to - from;
  // 目盛りの数は maxTicks 以下（スマホの狭い軸は少なく）。2 未満には絞らない
  const step = candidates.find((c) => span / c <= Math.max(2, maxTicks)) ?? candidates[candidates.length - 1];
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
  const digits = decimals ?? (scale.step >= 100 ? 0 : scale.step >= 1 ? 1 : decimalsOf(scale.step) + 1);
  return value.toFixed(digits);
}

/** 目盛りの文字。間隔と同じ桁にする（間隔 2 → 「18」、2.5 → 「17.5」、0.25 → 「0.75」、0.00005 → 「0.00105」） */
export function formatTick(value: number, scale: AxisScale): string {
  return value.toFixed(decimalsOf(scale.step));
}

/** 最後のデータから、受信が止まっているとみなすまでの時間（区間 3 つ分、ただし 10 分より短くしない） */
export function staleAfterMs(bucketSeconds: number): number {
  return Math.max(bucketSeconds * 3 * 1000, 10 * 60_000);
}

/**
 * 軸の幅（px）から、時間の目盛りの数の上限を決める（1 つに 64px ほど。文字が重ならないように）。
 * 例: maxTimeTicks(320) → 5、maxTimeTicks(900) → 8（上限）、幅が分からない（0）ときも 8
 */
export function maxTimeTicks(widthPx: number): number {
  if (widthPx <= 0) return 8;
  return Math.min(8, Math.max(2, Math.floor(widthPx / 64)));
}

/** 区間の幅の文字（例: 300000 → 「5 分」、30000 → 「30 秒」、7200000 → 「2 時間」）。切りのよい値に丸める */
export function describeInterval(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  // 近い切りのよい値（比で見て一番近いもの）
  const best = nice.reduce((a, b) => (Math.abs(Math.log(b / seconds)) < Math.abs(Math.log(a / seconds)) ? b : a));
  if (best >= 3600) return `${best / 3600} 時間`;
  if (best >= 60) return `${best / 60} 分`;
  return `${best} 秒`;
}

/** 表示範囲の短い名前（例: 24 時間 →「24H」、15 分 →「15M」、7 日 →「7D」）。切りのよくない幅は「N 分」 */
export function describeSpanShort(spanMs: number): string {
  const minutes = Math.round(spanMs / 60_000);
  // 1 日（24H）は時間で、2 日以上は日で出す（ボタンの 24H・7D と同じ呼び方）
  if (minutes >= 2880 && minutes % 1440 === 0) return `${minutes / 1440}D`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}H`;
  return `${minutes}M`;
}

/** 範囲の始めと終わりの文字（日本時間、例: 「11/17 09:42 — 11/18 09:42 JST」） */
export function formatRangeJst(from: number, to: number): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${fmt(from)} — ${fmt(to)} JST`;
}

// ---- グラフの上の札（最高・最低・カーソルの値）の置き場所 ----
// 札の大きさは、文字数から見積もる（描いてから測ると、置き直しで札が一瞬ずれるため）。位置はすべて、グラフの枠の左上からの px。

/** 札の四角（枠の左上から。px） */
export interface LabelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 文字の幅の見積もり（px）。全角（日本語）は文字の大きさ、半角は 0.62 倍。例: estimateTextWidth("最高 1103", 10) → 約 46 */
export function estimateTextWidth(text: string, fontPx: number): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) > 0x2e80 ? fontPx : fontPx * 0.62;
  return Math.ceil(width);
}

/** 最高・最低の札の高さ（10px の文字）と、カーソルの値の札の高さ（12px の文字） */
export const EXTREME_LABEL_HEIGHT = 14;
export const CURSOR_LABEL_HEIGHT = 18;
// 点と札のすきま
const LABEL_GAP = 5;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** 札が重なっているか（接しているだけは重なりとしない） */
export function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * 点（x, y）の上か下に、札を置く。左右は点を中心に置き、枠の外へ出ないよう内側へ寄せる（左 15% 付近でも切れない）。
 * 上下は、枠の外へ出ないよう収める。
 * 例: placeLabelAround({ x: 10, y: 60 }, { width: 80, height: 14 }, "above", { width: 400, height: 100 }) → { left: 0, top: 41, … }
 */
export function placeLabelAround(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  side: "above" | "below",
  plot: { width: number; height: number },
): LabelBox {
  const top = side === "above" ? anchor.y - size.height - LABEL_GAP : anchor.y + LABEL_GAP + 1;
  return {
    left: clamp(anchor.x - size.width / 2, 0, plot.width - size.width),
    top: clamp(top, 0, plot.height - size.height),
    width: size.width,
    height: size.height,
  };
}

/**
 * カーソルの値の札の置き場所。右寄り（70% より右）なら点の左、それ以外は右に置き、上寄りなら点の下、それ以外は上に置く
 * （枠の外へ出ないよう収める）。
 */
export function placeCursorLabel(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  plot: { width: number; height: number },
): LabelBox {
  const left = anchor.x > plot.width * 0.7 ? anchor.x - size.width - 8 : anchor.x + 8;
  const top = anchor.y < plot.height * 0.3 ? anchor.y + 4 : anchor.y - size.height - 4;
  return { left: clamp(left, 0, plot.width - size.width), top: clamp(top, 0, plot.height - size.height), width: size.width, height: size.height };
}

/** 置いた最高・最低の札。faded が true のときは、どこに置いても重なるので薄くする */
export interface PlacedLabel {
  box: LabelBox;
  faded: boolean;
}

/**
 * 最高・最低の札を置く。優先は、最高＝点の上・最低＝点の下。
 * カーソルの札（cursor。優先する）と、先に置いた札に重なるときは、反対側（最高なら下、最低なら上）へ逃がす。
 * 反対側でも重なるときは、元の側に置いて faded にする（薄くして、カーソルの値を読みやすくする）。
 * 例: 最高が行の上端なら、上には収まらないので、点の下に置く。
 */
export function placeExtremeLabels(input: {
  max: { x: number; y: number; width: number };
  min: { x: number; y: number; width: number };
  cursor: LabelBox | null;
  plot: { width: number; height: number };
}): { max: PlacedLabel; min: PlacedLabel } {
  const { plot, cursor } = input;
  const obstacles: LabelBox[] = cursor ? [cursor] : [];
  const place = (anchor: { x: number; y: number; width: number }, preferred: "above" | "below"): PlacedLabel => {
    const size = { width: anchor.width, height: EXTREME_LABEL_HEIGHT };
    const opposite = preferred === "above" ? "below" : "above";
    // 優先の側が枠に収まらないとき（行の端）は、最初から反対側を優先する
    const fitsPreferred = preferred === "above" ? anchor.y - size.height - LABEL_GAP >= 0 : anchor.y + LABEL_GAP + 1 + size.height <= plot.height;
    const order: Array<"above" | "below"> = fitsPreferred ? [preferred, opposite] : [opposite, preferred];
    for (const side of order) {
      const box = placeLabelAround(anchor, size, side, plot);
      if (!obstacles.some((other) => boxesOverlap(box, other))) {
        obstacles.push(box);
        return { box, faded: false };
      }
    }
    const box = placeLabelAround(anchor, size, order[0], plot);
    obstacles.push(box);
    return { box, faded: true };
  };
  // 最高を先に置き、最低は最高の札も避ける
  const max = place(input.max, "above");
  const min = place(input.min, "below");
  return { max, min };
}
