/**
 * 達成ストリップの計算（画面に依存しない純粋な関数）。
 *
 * 考え方:
 * - 表示期間（グラフと同じ、ダッシュボードの時間範囲）を、一定の間隔（1・5・10 分以上）の「マス」に区切る
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
export const DEFAULT_STRIP_BUCKET_MINUTES = 1;
export const DEFAULT_STRIP_HOURLY_TARGET = 60;
/** 1 つのウィジェットで取るマスの最大数（間引き API の上限 1000 に余裕を持たせる） */
export const MAX_STRIP_CELLS = 720;
/** マスの長さの候補（分）。表示期間が長いときは、この中で、最大数に収まる最短のものに広げる */
const BUCKET_LADDER = [1, 5, 10, 15, 30, 60, 120, 360, 1440] as const;

const MINUTE_MS = 60 * 1000;

/** 達成=緑、未達=赤、集計中=今のマスで未達成、対象外=勤務時間外・センサーが無かった期間 */
export type CellState = "ok" | "short" | "pending" | "off";

export interface StripSettings {
  /** 設定した 1 マスの長さ（最短）。表示期間が長いときは、stripWindow が広げる */
  bucketMinutes: number;
  hourlyTarget: number;
  workOnly: boolean;
  /** 1 分のマスで、前後のマスと 1 マス分まで融通するか。初期値は false（厳密: 毎分 目標以上が要る） */
  tolerant: boolean;
}

/** 保存された設定から、達成ストリップの設定を作る。未設定や範囲外の値は初期値に寄せる */
export function stripSettingsFromConfig(config: WidgetConfig): StripSettings {
  const bucket = config.stripBucketMinutes;
  const target = config.stripHourlyTarget;
  return {
    bucketMinutes: (STRIP_BUCKET_OPTIONS as readonly number[]).includes(bucket ?? -1) ? (bucket as number) : DEFAULT_STRIP_BUCKET_MINUTES,
    // 目標 0 は「常に達成」になり、未達を隠してしまうので認めない（正の数だけ）
    hourlyTarget: target !== undefined && Number.isFinite(target) && target > 0 ? target : DEFAULT_STRIP_HOURLY_TARGET,
    workOnly: config.stripWorkOnly ?? false,
    tolerant: config.stripTolerant ?? false,
  };
}

/** 数の表示（小数 1 桁まで、3 桁区切り）。ウィジェットと設定パネルで同じ形にする */
export function formatTargetNumber(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString("ja-JP");
}

/** 1 マスの目標（合計がこれ以上なら達成） */
export function bucketTarget(hourlyTarget: number, bucketMinutes: number): number {
  return (hourlyTarget * bucketMinutes) / 60;
}

export interface StripWindow {
  /** 取得する範囲（ミリ秒）。from・to はマスの境界で、最後のマスが今（または終了時刻）を含む */
  from: number;
  to: number;
  bucketMs: number;
  bucketCount: number;
  /** 実際の 1 マスの長さ（分）。設定より長くなることがある（表示期間が長いとき） */
  bucketMinutes: number;
}

/**
 * 表示範囲（グラフと同じ時間範囲）から、マスの区切りを決める。
 * マスの境界は分の倍数に合わせる。マスが MAX_STRIP_CELLS を超えるなら、マスの長さを広げる。
 */
export function stripWindow(range: { from: number; to: number }, minBucketMinutes: number): StripWindow {
  const ladder = BUCKET_LADDER.filter((minutes) => minutes >= minBucketMinutes);
  let chosen: number = ladder[ladder.length - 1] ?? minBucketMinutes;
  for (const minutes of ladder) {
    const bucketMs = minutes * MINUTE_MS;
    const count = Math.ceil(range.to / bucketMs) - Math.floor(range.from / bucketMs);
    if (count <= MAX_STRIP_CELLS) {
      chosen = minutes;
      break;
    }
  }
  const bucketMs = chosen * MINUTE_MS;
  const from = Math.floor(range.from / bucketMs) * bucketMs;
  // 右端が境界ちょうどでも、今のマス（次の 1 マス）を含める。固定の期間は、終了を含むマスまで
  const to = (Math.floor(range.to / bucketMs) + 1) * bucketMs;
  return { from, to, bucketMs, bucketCount: Math.round((to - from) / bucketMs), bucketMinutes: chosen };
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
 * - createdAtMs: センサーを作った時刻。それより前のマスと、作った時刻をまたぐマスは「対象外」（まだ無かった期間を、未達にしない）
 * - 勤務時間の外（workOnly のとき）は「対象外」。勤務時間に一部だけかかるマス（昼休みの終わりなど）は、
 *   その稼働時間の割合に目標を減らして判定する
 * - 設定「前後のマスと融通する」（stripTolerant、初期値は厳密）を入れた 1 分のマスだけ、前後のマスと 1 マス分まで融通する。値が来る間隔のわずかな揺れで、
 *   「2 回の次が 0 回」や「0 回の次が 2 回」となっても赤にしないため。本当に途切れたときは、
 *   2 マス続けて足りないので赤になる（累計の過不足が -1 マス分を下回る）
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
  const fullNeed = bucketTarget(settings.hourlyTarget, window.bucketMinutes);
  const schedule = scheduleFromConfig(config);
  const flexible = settings.tolerant && window.bucketMinutes === 1;
  let carry = 0; // 前のマスの余り（1 マス分まで。1 分のマスだけ使う）
  let previousDeficit = 0; // 直前のマスが赤のとき、足りなかった分
  const cells: StripCell[] = [];
  for (let i = 0; i < window.bucketCount; i++) {
    const startMs = window.from + i * window.bucketMs;
    const endMs = startMs + window.bucketMs;
    const sum = sums.get(i) ?? 0;
    // 作った時刻をまたぐマス、または前のマスは対象外
    const beforeSensor = createdAtMs !== null && startMs < createdAtMs;
    let workFraction = 1;
    if (settings.workOnly) {
      const startMinute = minuteOfDay(startMs);
      workFraction = workMinutesBetween(startMinute, startMinute + window.bucketMinutes, schedule) / window.bucketMinutes;
    }
    if (beforeSensor || workFraction === 0) {
      cells.push({ startMs, sum, state: "off" });
      carry = 0;
      previousDeficit = 0;
      continue;
    }
    const need = fullNeed * workFraction;
    const available = sum + carry;
    const enough = available >= need - 1e-9;
    let surplus = Math.max(available - need, 0);
    // 遅れて届いた分で、直前の赤が埋まるとき（0 回の次が 2 回）は、直前のマスを緑に直す。埋めた分は、このマスの余りから引く
    const previous = cells[cells.length - 1];
    if (flexible && enough && previous?.state === "short" && previousDeficit > 0 && surplus >= previousDeficit - 1e-9) {
      previous.state = "ok";
      surplus -= previousDeficit;
    }
    const complete = endMs <= nowMs;
    cells.push({ startMs, sum, state: enough ? "ok" : complete ? "short" : "pending" });
    if (complete) {
      carry = flexible && enough ? Math.min(surplus, need) : 0;
      previousDeficit = enough ? 0 : need - available;
    }
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
