/**
 * 達成ストリップの計算（画面に依存しない純粋な関数）。
 *
 * 考え方:
 * - 表示期間を、一定の間隔（1・5・10 分）の「マス」に区切る
 * - 1 マスの目標 = 1 時間あたりの目標 × 間隔 ÷ 60。マスの合計がこれ以上なら「達成」（緑）、未満なら「未達」（赤）
 * - 受信の確認（ハートビート）は、1 時間あたり 60・間隔 1 分の特別な場合（1 分に 1 回の値 1 が来たか）
 * - 生産の目標は、1 時間あたりの目標と間隔を決めるだけ（勤務時間の外は「対象外」にできる）
 * - 今の途中のマスは、まだ判定しない（満たしていれば緑、未満なら「集計中」）
 *
 * 【誰が使うか】TargetStripWidget、設定パネル（TargetStripSettings の「1 マスの目標」の表示）。
 */
import type { WidgetConfig } from "../types";
import { minuteOfDay, scheduleFromConfig, workMinutesBetween } from "./production-plan";

export const STRIP_BUCKET_OPTIONS = [1, 5, 10] as const;
export const STRIP_HOURS_OPTIONS = [2, 6, 12] as const;
export const DEFAULT_STRIP_BUCKET_MINUTES = 1;
export const DEFAULT_STRIP_HOURLY_TARGET = 60;
export const DEFAULT_STRIP_HOURS = 2;

const MINUTE_MS = 60 * 1000;

/** 達成=緑、未達=赤、集計中=今のマスで未達成、対象外=勤務時間外・センサーが無かった期間 */
export type CellState = "ok" | "short" | "pending" | "off";

export interface StripSettings {
  bucketMinutes: number;
  hours: number;
  hourlyTarget: number;
  workOnly: boolean;
}

/** 保存された設定から、達成ストリップの設定を作る。未設定や範囲外の値は初期値に寄せる */
export function stripSettingsFromConfig(config: WidgetConfig): StripSettings {
  const bucket = config.stripBucketMinutes;
  const hours = config.stripHours;
  const target = config.stripHourlyTarget;
  return {
    bucketMinutes: (STRIP_BUCKET_OPTIONS as readonly number[]).includes(bucket ?? -1) ? (bucket as number) : DEFAULT_STRIP_BUCKET_MINUTES,
    hours: (STRIP_HOURS_OPTIONS as readonly number[]).includes(hours ?? -1) ? (hours as number) : DEFAULT_STRIP_HOURS,
    hourlyTarget: target !== undefined && Number.isFinite(target) && target >= 0 ? target : DEFAULT_STRIP_HOURLY_TARGET,
    workOnly: config.stripWorkOnly ?? false,
  };
}

/** 1 マスの目標（合計がこれ以上なら達成） */
export function bucketTarget(hourlyTarget: number, bucketMinutes: number): number {
  return (hourlyTarget * bucketMinutes) / 60;
}

export interface StripWindow {
  /** 取得する範囲（ミリ秒）。from はマスの境界で、to は今を含むマスの終わり */
  from: number;
  to: number;
  bucketMs: number;
  bucketCount: number;
}

/** 今から見た表示範囲。マスの境界（分の倍数）に合わせ、最後のマスが「今」を含むようにする */
export function stripWindow(nowMs: number, bucketMinutes: number, hours: number): StripWindow {
  const bucketMs = bucketMinutes * MINUTE_MS;
  const to = (Math.floor(nowMs / bucketMs) + 1) * bucketMs;
  const bucketCount = Math.round((hours * 60) / bucketMinutes);
  return { from: to - bucketCount * bucketMs, to, bucketMs, bucketCount };
}

/** 間引き API の区間（開始・平均・件数）。合計 = 平均 × 件数 */
export interface DownsampledBucketLike {
  start: string;
  avg: number;
  count: number;
}

export interface StripCell {
  startMs: number;
  /** マスの合計。データが無ければ 0 */
  sum: number;
  state: CellState;
}

/**
 * マスごとの合計と状態を作る。
 * - createdAtMs: センサーを作った時刻。それより前のマスは「対象外」（まだ無かった期間を、未達にしない）
 * - 勤務時間の外（workOnly のとき）は「対象外」
 */
export function buildCells(
  buckets: readonly DownsampledBucketLike[],
  window: StripWindow,
  nowMs: number,
  settings: StripSettings,
  config: WidgetConfig,
  createdAtMs: number | null,
): StripCell[] {
  const sums = new Map<number, number>();
  for (const bucket of buckets) {
    const index = Math.round((new Date(bucket.start).getTime() - window.from) / window.bucketMs);
    sums.set(index, (sums.get(index) ?? 0) + bucket.avg * bucket.count);
  }
  const need = bucketTarget(settings.hourlyTarget, settings.bucketMinutes);
  const schedule = scheduleFromConfig(config);
  const cells: StripCell[] = [];
  for (let i = 0; i < window.bucketCount; i++) {
    const startMs = window.from + i * window.bucketMs;
    const endMs = startMs + window.bucketMs;
    const sum = sums.get(i) ?? 0;
    let state: CellState;
    const beforeSensor = createdAtMs !== null && endMs <= createdAtMs;
    const outsideWork =
      settings.workOnly && workMinutesBetween(minuteOfDay(startMs), minuteOfDay(startMs) + settings.bucketMinutes, schedule) === 0;
    if (beforeSensor || outsideWork) {
      state = "off";
    } else if (endMs > nowMs) {
      // 今の途中のマス。満たしていれば緑、まだなら集計中（赤にはしない）
      state = sum >= need - 1e-9 ? "ok" : "pending";
    } else {
      state = sum >= need - 1e-9 ? "ok" : "short";
    }
    cells.push({ startMs, sum, state });
  }
  return cells;
}

export type StripLevel = "ok" | "warn" | "bad";

export interface StripSummary {
  /** 判定したマス（達成 + 未達）。集計中・対象外は数えない */
  judged: number;
  okCount: number;
  shortCount: number;
  /** 達成率（%）。判定したマスが無ければ null */
  percent: number | null;
  /** 直近の完結したマスから数えた、連続する未達の数 */
  trailingShort: number;
  /** 丸印: 未達が連続 0 なら緑、1〜2 なら黄、3 以上なら赤 */
  level: StripLevel;
}

export function summarizeCells(cells: readonly StripCell[]): StripSummary {
  let okCount = 0;
  let shortCount = 0;
  for (const cell of cells) {
    if (cell.state === "ok") okCount++;
    else if (cell.state === "short") shortCount++;
  }
  const judged = okCount + shortCount;
  // 末尾から、完結したマスだけを見る（集計中・対象外は飛ばす）
  let trailingShort = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const state = cells[i].state;
    if (state === "pending" || state === "off") continue;
    if (state === "short") trailingShort++;
    else break;
  }
  return {
    judged,
    okCount,
    shortCount,
    percent: judged > 0 ? Math.round((okCount / judged) * 100) : null,
    trailingShort,
    level: trailingShort >= 3 ? "bad" : trailingShort >= 1 ? "warn" : "ok",
  };
}
