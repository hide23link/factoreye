/**
 * ダッシュボードのグラフの表示時間範囲（Zustand）。
 *
 * - 範囲はダッシュボードに 1 つ。SensorGraph と MultiSensorComparison は、この範囲に従う
 * - 範囲は URL（?range=1h / ?from=…&to=…）に反映する。リンクで同じ表示を開ける
 * - 範囲はダッシュボードの設定（サーバー側）には保存しないが、最後に見ていた範囲は
 *   この端末の localStorage に残す。次に開いたとき、URL に指定が無ければそれを使う
 *   （毎回「直近 1 時間」に戻ると不便、という利用者の要望のため）
 *
 * 【誰が使うか】DashboardView、TimeRangeControls、グラフ系の2つのウィジェット。
 */
import { create } from "zustand";

import { DEFAULT_RANGE, fromSearchParams, toSearchParams, type TimeRange } from "../lib/timeRange";

// localStorage に保存するときの鍵の名前
const TIME_RANGE_KEY = "factoreye_time_range";

interface TimeRangeState {
  range: TimeRange;
  /** 範囲を変える。URL と localStorage も同じ内容に書き換える（URL の履歴は増やさない） */
  setRange: (range: TimeRange) => void;
}

function isValidTimeRange(value: unknown): value is TimeRange {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.mode === "relative") return typeof v.durationMs === "number" && v.durationMs > 0;
  if (v.mode === "absolute") {
    return typeof v.from === "number" && typeof v.to === "number" && v.to > v.from;
  }
  return false;
}

/** 最後に見ていた範囲を localStorage から読む。保存が無い・壊れている・使えない環境では null */
function readStoredRange(): TimeRange | null {
  try {
    const raw = localStorage.getItem(TIME_RANGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidTimeRange(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 範囲を localStorage に保存する（使えない環境では無視） */
function writeStoredRange(range: TimeRange) {
  try {
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify(range));
  } catch {
    // noop
  }
}

/** 範囲の部分だけを、URL のクエリに書き換える（ほかのクエリは残す） */
function writeUrl(range: TimeRange) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("range");
    url.searchParams.delete("from");
    url.searchParams.delete("to");
    toSearchParams(range).forEach((value, key) => url.searchParams.set(key, value));
    window.history.replaceState(null, "", url.toString());
  } catch {
    // URL を書き換えられない環境（プレビューなど）では、画面の状態だけを使う
  }
}

/** URL から範囲の部分を消す（画面を離れるとき） */
function clearUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("range");
    url.searchParams.delete("from");
    url.searchParams.delete("to");
    window.history.replaceState(null, "", url.toString());
  } catch {
    // 上と同じく、書けなくても画面の動作には影響させない
  }
}

export const useTimeRangeStore = create<TimeRangeState>()((set) => ({
  range: DEFAULT_RANGE,
  setRange: (range) => {
    set({ range });
    writeUrl(range);
    writeStoredRange(range);
  },
}));

/**
 * ダッシュボードを開くとき: URL に範囲があればそれを使う。
 * 無ければ、この端末で最後に見ていた範囲（localStorage）を使う。どちらも無ければ既定（直近 1 時間）。
 */
export function initTimeRangeFromUrl() {
  let fromUrl: TimeRange | null = null;
  try {
    fromUrl = fromSearchParams(window.location.search);
  } catch {
    fromUrl = null;
  }
  useTimeRangeStore.setState({ range: fromUrl ?? readStoredRange() ?? DEFAULT_RANGE });
}

/**
 * ダッシュボードを閉じるとき: 画面の状態は既定に戻し、URL の範囲も消す。
 * localStorage の値は消さない（次に開いたとき、そこから復元するため）
 */
export function resetTimeRange() {
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
  clearUrl();
}
