/**
 * ダッシュボードのグラフの表示時間範囲（Zustand）。
 *
 * - 範囲はダッシュボードに 1 つ。SensorGraph と MultiSensorComparison は、この範囲に従う
 * - 範囲は URL（?range=1h / ?from=…&to=…）に反映する。リンクで同じ表示を開ける
 * - 範囲はダッシュボードの設定に保存しない。画面を開き直すと、URL か既定（直近 1 時間）に戻る
 */
import { create } from "zustand";

import { DEFAULT_RANGE, fromSearchParams, toSearchParams, type TimeRange } from "../lib/timeRange";

interface TimeRangeState {
  range: TimeRange;
  /** 範囲を変える。URL も同じ内容に書き換える（履歴は増やさない） */
  setRange: (range: TimeRange) => void;
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
  },
}));

/** ダッシュボードを開くとき: URL に範囲があればそれを、無ければ既定（直近 1 時間）にする */
export function initTimeRangeFromUrl() {
  let fromUrl: TimeRange | null = null;
  try {
    fromUrl = fromSearchParams(window.location.search);
  } catch {
    fromUrl = null;
  }
  useTimeRangeStore.setState({ range: fromUrl ?? DEFAULT_RANGE });
}

/** ダッシュボードを閉じるとき: 既定に戻し、URL の範囲も消す */
export function resetTimeRange() {
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
  clearUrl();
}
