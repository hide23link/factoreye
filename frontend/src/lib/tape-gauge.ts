/**
 * 計器（帯の目盛りの上を、今の値の印が動く表示）の計算。
 *
 * - 目盛りの範囲と色の帯は、ゲージ（lib/gauge.ts）と同じ決め方
 * - 目盛りの数字は、範囲を切りのよい間隔で区切る（lib/trend-stack.ts の niceScale と同じ考え方）
 * - 1 時間の変化と 15 分後の予測は、直近 1 時間の測定値から求める
 *
 * 【誰が使うか】components/widgets/TapeGaugeWidget.tsx。
 */
import type { Reading, Sensor, WidgetConfig } from "../types";
import type { GaugeRange } from "./gauge";
import { niceScale } from "./trend-stack";

/** 目盛りの数字の位置（範囲全体に対する 0〜1）と文字 */
export interface TapeTick {
  fraction: number;
  value: number;
}

// 変化を求めるのに要る、測定値の幅の最短（これより短いと、変化を出さない）
const MIN_TREND_SPAN_MS = 20 * 60_000;
// 予測の先の長さ（分）
export const PREDICT_MINUTES = 15;
// 目盛りの数字どうしが、これより近い（範囲に対する割合）と、片方を省く（文字が重ならないように）
const MIN_TICK_GAP = 0.16;

type Limits = Pick<Sensor, "thresholdMinCritical" | "thresholdMinWarning" | "thresholdMaxWarning" | "thresholdMaxCritical">;

/**
 * 帯の目盛りの範囲。設定で範囲を固定していればそれ（gaugeMin < gaugeMax）。
 * 自動のときは、しきい値と今の値が収まる範囲に、両側 25% の余裕を足し、切りのよい目盛りの端にそろえる。
 * 例: しきい値 16・18・26・28、今の値 22.3 → 13〜31 を 6 区間以内に分け、10〜35 のような端にする
 * （ゲージ lib/gauge.ts の自動の範囲は 0 から始まることが多く、帯だと余白が広すぎて、値の位置が読みにくいため、別に決める）
 */
export function tapeRange(sensor: Limits, config: WidgetConfig, latest: number | undefined): GaugeRange {
  const { gaugeMin, gaugeMax } = config;
  if (gaugeMin !== undefined && gaugeMax !== undefined && Number.isFinite(gaugeMin) && Number.isFinite(gaugeMax) && gaugeMin < gaugeMax) {
    return { min: gaugeMin, max: gaugeMax };
  }
  const values = [
    sensor.thresholdMinCritical,
    sensor.thresholdMinWarning,
    sensor.thresholdMaxWarning,
    sensor.thresholdMaxCritical,
    latest ?? null,
  ].filter((value): value is number => value !== null);
  if (values.length === 0) return { min: 0, max: 100 };
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low > 0 ? high - low : Math.max(Math.abs(high) * 0.2, 1);
  const scale = niceScale(low - span * 0.25, high + span * 0.25, 6);
  return { min: scale.min, max: scale.max };
}

/**
 * 範囲を、切りのよい間隔で区切った目盛り（両端を必ず入れる。近すぎる数字は省く）。
 * 例: 範囲 12〜32 → 12・20・32（間の 15・20・25・30 のうち、端に近すぎず、おたがいに離れたものだけ）
 */
export function tapeTicks(range: GaugeRange, maxTicks = 4): TapeTick[] {
  const span = range.max - range.min;
  const scale = niceScale(range.min, range.max, maxTicks);
  const toTick = (value: number): TapeTick => ({ value, fraction: (value - range.min) / span });
  const ends = [toTick(range.min), toTick(range.max)];
  const inside = scale.ticks.filter((value) => value > range.min && value < range.max).map(toTick);
  const kept: TapeTick[] = [ends[0]];
  for (const tick of inside) {
    const farFromLast = tick.fraction - kept[kept.length - 1].fraction >= MIN_TICK_GAP;
    const farFromEnd = 1 - tick.fraction >= MIN_TICK_GAP;
    if (farFromLast && farFromEnd) kept.push(tick);
  }
  kept.push(ends[1]);
  return kept;
}

/**
 * 1 時間あたりの変化（単位/時）。測定値は新しい順（先頭が最新）。
 * 20 分未満しか間が無い・測定値が 2 件未満のときは null（変化は出さない）。
 */
export function hourlyTrend(readingsNewestFirst: ReadonlyArray<Pick<Reading, "value" | "recordedAt">>): number | null {
  if (readingsNewestFirst.length < 2) return null;
  const newest = readingsNewestFirst[0];
  const oldest = readingsNewestFirst[readingsNewestFirst.length - 1];
  const span = new Date(newest.recordedAt).getTime() - new Date(oldest.recordedAt).getTime();
  if (span < MIN_TREND_SPAN_MS) return null;
  return ((newest.value - oldest.value) / span) * 3_600_000;
}

/** PREDICT_MINUTES 分後の予測値（今の傾きが続くとした場合）。変化が分からなければ null */
export function predictedValue(value: number, trendPerHour: number | null): number | null {
  return trendPerHour === null ? null : value + (trendPerHour * PREDICT_MINUTES) / 60;
}
