/**
 * 状態の帯（StateTimeline ウィジェット）の計算。
 * センサー 1 本の間引きデータ（区間約 144 本）から、区間ごとの状態を決め、同じ状態が続く区間を 1 本の帯にまとめ、稼働率を出す。
 * 帯・ホバーの文・稼働率は、すべてここで同じ区間から求める（目分量で描かない）。
 *
 * 状態は 4 つ。優先は「受信なし > 警報 > 停止 > 稼働」。
 * - 受信なし: 区間に値が無い（件数 0・区間そのものが無い）
 * - 警報: 区間の中の値が、軽故障・重故障のしきい値を超えた（重故障＝赤、軽故障＝橙）。区間の最高・最低で見るので、短い超過も逃さない
 * - 停止: 「停止とみなす値」を設定した行だけ。区間の最高がその値以下（区間のすべての値が、その値以下）
 * - 稼働: 値を受信していて、警報でも停止でもない
 *
 * 稼働率 = 稼働の区間 ÷ 表示範囲の全区間（受信なし・警報・停止は稼働に数えない）。
 *
 * 【誰が使うか】components/widgets/StateTimelineWidget.tsx。
 */
import type { DownsampledBucket } from "./api";
import { levelOf, type TrendLimit } from "./trend-stack";

/** 区間・帯の状態。none = 受信なし、alarm = 警報、stopped = 停止、running = 稼働 */
export type TimelineState = "none" | "alarm" | "stopped" | "running";

/** 区間 1 つの判定。alarm のときだけ level（警報の段階）がある */
export interface TimelineCell {
  state: TimelineState;
  level?: "critical" | "warning";
}

/** 同じ状態が続く区間をまとめた帯 1 本。startMs〜endMs は表示範囲の中の時刻（ミリ秒） */
export interface TimelineSegment {
  state: TimelineState;
  level?: "critical" | "warning";
  startMs: number;
  endMs: number;
  /** 表示範囲に対する位置と幅（0〜100%） */
  leftPercent: number;
  widthPercent: number;
}

/** 区間 1 つ分の判定に使う値（DownsampledBucket の一部） */
type BucketLike = Pick<DownsampledBucket, "min" | "max" | "count">;

/**
 * 区間 1 つの状態を決める。優先は 受信なし > 警報 > 停止 > 稼働。
 * 例: bucketCell(undefined, [], null) → 受信なし ／ bucketCell({min:0,max:0,count:3}, [], 0) → 停止（0 以下）
 */
export function bucketCell(bucket: BucketLike | undefined, limits: ReadonlyArray<TrendLimit>, stopAt: number | null): TimelineCell {
  if (!bucket || bucket.count <= 0) return { state: "none" };
  // 区間の最高と最低の両方を見て、重い方の警報にする（上限を超えた山も、下限を割った谷も拾う）
  const levels = [levelOf(bucket.max, limits), levelOf(bucket.min, limits)];
  if (levels.includes("critical")) return { state: "alarm", level: "critical" };
  if (levels.includes("warning")) return { state: "alarm", level: "warning" };
  if (stopAt !== null && bucket.max <= stopAt) return { state: "stopped" };
  return { state: "running" };
}

/**
 * 表示範囲（from〜to）を cellCount 等分した区間ごとの状態。データの無い区間は受信なし。
 * 区間の位置は、API と同じく from からの等間隔（(to - from) / cellCount）で、開始時刻から求める。
 */
export function buildTimelineCells(
  buckets: ReadonlyArray<Pick<DownsampledBucket, "start" | "min" | "max" | "count">>,
  fromMs: number,
  toMs: number,
  cellCount: number,
  limits: ReadonlyArray<TrendLimit>,
  stopAt: number | null,
): TimelineCell[] {
  const width = (toMs - fromMs) / cellCount;
  const byIndex = new Map<number, BucketLike>();
  for (const bucket of buckets) {
    const index = Math.min(cellCount - 1, Math.floor((new Date(bucket.start).getTime() - fromMs) / width));
    if (index >= 0) byIndex.set(index, bucket);
  }
  return Array.from({ length: cellCount }, (_, i) => bucketCell(byIndex.get(i), limits, stopAt));
}

/** 同じ状態（警報は段階も同じ）が続く区間を、1 本の帯にまとめる。帯の右端は表示範囲の右端（toMs）を越えない */
export function buildSegments(cells: ReadonlyArray<TimelineCell>, fromMs: number, toMs: number): TimelineSegment[] {
  const span = toMs - fromMs;
  const width = span / Math.max(1, cells.length);
  const segments: TimelineSegment[] = [];
  let start = 0;
  for (let i = 1; i <= cells.length; i++) {
    const same = i < cells.length && cells[i].state === cells[start].state && cells[i].level === cells[start].level;
    if (same) continue;
    const startMs = fromMs + start * width;
    const endMs = Math.min(toMs, fromMs + i * width);
    segments.push({
      state: cells[start].state,
      level: cells[start].level,
      startMs,
      endMs,
      leftPercent: span > 0 ? ((startMs - fromMs) / span) * 100 : 0,
      widthPercent: span > 0 ? ((endMs - startMs) / span) * 100 : 0,
    });
    start = i;
  }
  return segments;
}

/** 稼働率（%、整数）。稼働の区間 ÷ 全区間。区間が無ければ null */
export function uptimePercent(cells: ReadonlyArray<TimelineCell>): number | null {
  if (cells.length === 0) return null;
  const running = cells.filter((cell) => cell.state === "running").length;
  return Math.round((running / cells.length) * 100);
}

const STATE_LABEL: Record<TimelineState, string> = { none: "受信なし", alarm: "警報", stopped: "停止", running: "稼働" };

/** 状態の名前（ホバー・凡例・読み上げ用）。警報は段階も付ける（例: 警報（重故障）） */
export function stateLabel(state: TimelineState, level?: "critical" | "warning"): string {
  if (state !== "alarm" || !level) return STATE_LABEL[state];
  return `警報（${level === "critical" ? "重故障" : "軽故障"}）`;
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
const mdhhmm = (ms: number) => `${new Date(ms).getMonth() + 1}/${new Date(ms).getDate()} ${hhmm(ms)}`;

/**
 * 帯にカーソルを置いたときの文。例: 「警報（重故障） 11:42〜12:58（76 分）」。
 * 1 日を超える長さの帯は、日付も付ける（長い帯は、時間より日・時間で）。
 */
export function describeSegment(segment: TimelineSegment): string {
  const minutes = Math.max(1, Math.round((segment.endMs - segment.startMs) / 60_000));
  const longSpan = segment.endMs - segment.startMs >= 24 * 3_600_000 || new Date(segment.startMs).getDate() !== new Date(segment.endMs).getDate();
  const format = longSpan ? mdhhmm : hhmm;
  const length = minutes >= 120 ? `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分` : `${minutes} 分`;
  return `${stateLabel(segment.state, segment.level)} ${format(segment.startMs)}〜${format(segment.endMs)}（${length}）`;
}
