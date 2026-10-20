/**
 * 生産管理ウィジェットの計算（画面に依存しない純粋な関数）。
 *
 * 考え方:
 * - 計画 = 1日の目標 ÷ 稼働時間（休憩を除く）を、稼働している時間に均等に割ったもの
 * - 見込み = 今までの稼働時間あたりのペースを、終業まで延長したもの
 * - 停止時間 = 稼働時間中に、生産が 0 だった 10 分区間の数 × 10 分
 *
 * 時刻はすべて「その日の 0 時からの分」で扱う（ローカル時間）。
 *
 * 【誰が使うか】ProductionPlanWidget、設定パネル（ProductionPlanSettings の「1時間あたり」の表示）。
 */
import type { WidgetConfig } from "../types";

/** 勤務の予定。昼休みは 12:00 から始まる（設定項目を増やさないため固定） */
export interface WorkSchedule {
  startHour: number;
  endHour: number;
  breakMinutes: number;
}

export const DEFAULT_SCHEDULE: WorkSchedule = { startHour: 8, endHour: 17, breakMinutes: 60 };
export const DEFAULT_DAILY_TARGET = 1000;

/** 昼休みの開始（12:00）。分 */
export const BREAK_START_MINUTE = 12 * 60;

/** 停止時間を数える区間の長さ（分） */
export const STOP_BUCKET_MINUTES = 10;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 保存された設定から勤務の予定を作る。未設定や範囲外の値は、初期値（8〜17 時・昼休み 60 分）に寄せる */
export function scheduleFromConfig(config: WidgetConfig): WorkSchedule {
  const startHour = clamp(Math.round(config.workStartHour ?? DEFAULT_SCHEDULE.startHour), 0, 23);
  // 終了は開始より後にする（同じか前だと稼働時間が 0 以下になり、計画が計算できない）
  const endHour = clamp(Math.round(config.workEndHour ?? DEFAULT_SCHEDULE.endHour), startHour + 1, 24);
  const breakMinutes = clamp(Math.round(config.breakMinutes ?? DEFAULT_SCHEDULE.breakMinutes), 0, 180);
  return { startHour, endHour, breakMinutes };
}

/** 2つの区間 [aFrom, aTo) と [bFrom, bTo) が重なる長さ */
function overlap(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));
}

/** [fromMin, toMin) のうち、稼働している（勤務時間内で、昼休みでない）分数 */
export function workMinutesBetween(fromMin: number, toMin: number, schedule: WorkSchedule): number {
  const start = schedule.startHour * 60;
  const end = schedule.endHour * 60;
  const breakEnd = BREAK_START_MINUTE + schedule.breakMinutes;
  // 勤務時間を、昼休みの前と後の 2 つに分けて数える
  const before = overlap(fromMin, toMin, start, Math.min(end, BREAK_START_MINUTE));
  const after = overlap(fromMin, toMin, Math.max(start, breakEnd), end);
  return before + after;
}

/** 1日の稼働時間（分、休憩を除く） */
export function totalWorkMinutes(schedule: WorkSchedule): number {
  return workMinutesBetween(0, 24 * 60, schedule);
}

/** 稼働時間 1 時間あたりの計画数。稼働時間が 0 のときは 0 */
export function planPerWorkHour(target: number, schedule: WorkSchedule): number {
  const minutes = totalWorkMinutes(schedule);
  return minutes > 0 ? target / (minutes / 60) : 0;
}

/** 時刻（分）までに、計画では何個作っているはずか */
export function planUntil(target: number, schedule: WorkSchedule, minute: number): number {
  const perMinute = planPerWorkHour(target, schedule) / 60;
  return perMinute * workMinutesBetween(0, minute, schedule);
}

/** 10 分区間ごとの生産数。start はその日の 0 時からの分（10 の倍数） */
export interface CountBucket {
  startMinute: number;
  count: number;
}

export type HourState = "break" | "done" | "now" | "future";

export interface HourRow {
  hour: number;
  plan: number;
  actual: number;
  state: HourState;
}

export interface ProductionSummary {
  actual: number;
  target: number;
  achievementPercent: number;
  planNow: number;
  /** 実績 − 計画（正なら先行、負なら遅れ） */
  diff: number;
  forecast: number;
  forecastPercent: number;
  /** 稼働時間のうち、ここまでに終わった 10 分区間の数が 0 のときは null */
  uptimePercent: number | null;
  stopMinutes: number;
  planPerHour: number;
  workHours: number;
  hours: HourRow[];
}

/** 時間帯（hour 時台）の状態。稼働時間が 0 なら休憩、今を過ぎていれば done、今を含めば now、先なら future */
function hourState(hour: number, schedule: WorkSchedule, nowMinute: number): HourState {
  if (workMinutesBetween(hour * 60, hour * 60 + 60, schedule) === 0) return "break";
  if (hour * 60 + 60 <= nowMinute) return "done";
  if (hour * 60 <= nowMinute) return "now";
  return "future";
}

/**
 * 実績・計画・見込み・稼働率をまとめて計算する。
 *
 * @param buckets 勤務時間帯の 10 分区間ごとの生産数。測定値が無い区間は含めなくてよい（0 として数える）
 * @param nowMinute 今の時刻（その日の 0 時からの分）
 */
export function summarizeProduction(
  target: number,
  schedule: WorkSchedule,
  buckets: CountBucket[],
  nowMinute: number,
): ProductionSummary {
  const start = schedule.startHour * 60;
  const end = schedule.endHour * 60;
  const inWindow = buckets.filter((b) => b.startMinute >= start && b.startMinute < end);
  const actual = inWindow.reduce((sum, b) => sum + b.count, 0);

  const planNow = planUntil(target, schedule, nowMinute);
  const elapsedWork = workMinutesBetween(0, nowMinute, schedule);
  const remainingWork = totalWorkMinutes(schedule) - elapsedWork;
  // 稼働時間がまだ 0 分（始業前）なら、ペースが分からないので、今の実績のまま
  const paceRate = elapsedWork > 0 ? actual / elapsedWork : 0;
  const forecast = actual + paceRate * remainingWork;

  // 停止の判定: 終わった区間のうち、全体が稼働時間に入るものだけを数える（昼休みをまたぐ区間は除く）
  const countByStart = new Map(inWindow.map((b) => [b.startMinute, b.count]));
  let judged = 0;
  let stopped = 0;
  for (let minute = start; minute + STOP_BUCKET_MINUTES <= Math.min(end, nowMinute); minute += STOP_BUCKET_MINUTES) {
    if (workMinutesBetween(minute, minute + STOP_BUCKET_MINUTES, schedule) < STOP_BUCKET_MINUTES) continue;
    judged += 1;
    if ((countByStart.get(minute) ?? 0) === 0) stopped += 1;
  }

  const perHour = planPerWorkHour(target, schedule);
  const hours: HourRow[] = [];
  for (let hour = schedule.startHour; hour < schedule.endHour; hour += 1) {
    hours.push({
      hour,
      plan: (perHour * workMinutesBetween(hour * 60, hour * 60 + 60, schedule)) / 60,
      actual: inWindow
        .filter((b) => b.startMinute >= hour * 60 && b.startMinute < hour * 60 + 60)
        .reduce((sum, b) => sum + b.count, 0),
      state: hourState(hour, schedule, nowMinute),
    });
  }

  return {
    actual,
    target,
    achievementPercent: target > 0 ? (actual / target) * 100 : 0,
    planNow,
    diff: actual - planNow,
    forecast,
    forecastPercent: target > 0 ? (forecast / target) * 100 : 0,
    uptimePercent: judged > 0 ? Math.round((1 - stopped / judged) * 100) : null,
    stopMinutes: stopped * STOP_BUCKET_MINUTES,
    planPerHour: perHour,
    workHours: totalWorkMinutes(schedule) / 60,
    hours,
  };
}

/** 計画との差の評価。先行・ほぼ計画どおり（目標の 5% 以内の遅れ）・大きく遅れ */
export type PlanTone = "ok" | "warn" | "crit";

export function planTone(diff: number, target: number): PlanTone {
  if (diff >= 0) return "ok";
  return diff > -target * 0.05 ? "warn" : "crit";
}

/** 終業時の見込みの評価（目標に対する割合）。100% 以上は ok、95% 以上は warn */
export function forecastTone(forecastPercent: number): PlanTone {
  return forecastPercent >= 100 ? "ok" : forecastPercent >= 95 ? "warn" : "crit";
}

/** 現在時刻（ミリ秒）を、その日の 0 時からの分にする（ローカル時間） */
export function minuteOfDay(timeMs: number): number {
  const d = new Date(timeMs);
  return d.getHours() * 60 + d.getMinutes();
}
