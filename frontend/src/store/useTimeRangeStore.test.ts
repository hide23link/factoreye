import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_RANGE } from "../lib/timeRange";
import { initTimeRangeFromUrl, resetTimeRange, useTimeRangeStore } from "./useTimeRangeStore";

const TIME_RANGE_KEY = "factoreye_time_range";

function setUrl(search: string) {
  window.history.replaceState(null, "", `/dashboards/1${search}`);
}

beforeEach(() => {
  localStorage.clear();
  setUrl("");
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
});

afterEach(() => {
  localStorage.clear();
  setUrl("");
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
});

describe("useTimeRangeStore の永続化", () => {
  it("setRange で変えた範囲は localStorage に保存される", () => {
    useTimeRangeStore.getState().setRange({ mode: "relative", durationMs: 6 * 60 * 60 * 1000 });

    expect(JSON.parse(localStorage.getItem(TIME_RANGE_KEY) ?? "null")).toEqual({
      mode: "relative",
      durationMs: 6 * 60 * 60 * 1000,
    });
  });

  it("固定の期間は localStorage に保存しない（次に開いたとき過去の日時のままになるため）", () => {
    useTimeRangeStore.getState().setRange({ mode: "absolute", from: 1_000, to: 2_000 });

    expect(localStorage.getItem(TIME_RANGE_KEY)).toBeNull();
  });

  it("以前の版が保存した固定の期間は使わず、既定（直近 1 時間）で開く", () => {
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify({ mode: "absolute", from: 1_000, to: 2_000 }));

    initTimeRangeFromUrl();

    expect(useTimeRangeStore.getState().range).toEqual(DEFAULT_RANGE);
  });

  it("URL に範囲が無ければ、localStorage の最後の範囲を使う", () => {
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify({ mode: "relative", durationMs: 24 * 60 * 60 * 1000 }));

    initTimeRangeFromUrl();

    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 24 * 60 * 60 * 1000 });
  });

  it("URL に範囲があれば、localStorage より優先する", () => {
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify({ mode: "relative", durationMs: 24 * 60 * 60 * 1000 }));
    setUrl("?range=15m");

    initTimeRangeFromUrl();

    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 15 * 60 * 1000 });
  });

  it("URL も localStorage も無ければ既定（直近 1 時間）", () => {
    initTimeRangeFromUrl();

    expect(useTimeRangeStore.getState().range).toEqual(DEFAULT_RANGE);
  });

  it("localStorage の内容が壊れていても既定にフォールバックする", () => {
    localStorage.setItem(TIME_RANGE_KEY, "{not-json");

    initTimeRangeFromUrl();

    expect(useTimeRangeStore.getState().range).toEqual(DEFAULT_RANGE);
  });

  it("resetTimeRange は画面の状態と URL を既定に戻すが、localStorage は消さない", () => {
    useTimeRangeStore.getState().setRange({ mode: "relative", durationMs: 6 * 60 * 60 * 1000 });

    resetTimeRange();

    expect(useTimeRangeStore.getState().range).toEqual(DEFAULT_RANGE);
    expect(window.location.search).toBe("");
    expect(JSON.parse(localStorage.getItem(TIME_RANGE_KEY) ?? "null")).toEqual({
      mode: "relative",
      durationMs: 6 * 60 * 60 * 1000,
    });
  });

  it("閉じて再び開くと、保存されていた範囲に戻る（開く→閉じる→開く）", () => {
    useTimeRangeStore.getState().setRange({ mode: "relative", durationMs: 6 * 60 * 60 * 1000 });

    resetTimeRange();
    initTimeRangeFromUrl();

    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 6 * 60 * 60 * 1000 });
  });
});
