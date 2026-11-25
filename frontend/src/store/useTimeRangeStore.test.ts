import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RANGE } from "../lib/timeRange";
import { followBrowserBack, initTimeRangeFromUrl, resetTimeRange, setRangeByWheel, useTimeRangeStore } from "./useTimeRangeStore";

const TIME_RANGE_KEY = "factoreye_time_range";

function setUrl(search: string) {
  window.history.replaceState(null, "", `/dashboards/1${search}`);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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

  it("ホーム画面のショートカットなどで開いた URL の固定の期間は使わず、URL からも消して、最後の直近の範囲で開く", () => {
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify({ mode: "relative", durationMs: 6 * 60 * 60 * 1000 }));
    setUrl("?from=2026-11-02T03:51:00.000Z&to=2026-11-02T04:06:00.000Z");

    initTimeRangeFromUrl();

    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 6 * 60 * 60 * 1000 });
    expect(window.location.search).toBe("");
  });

  it("同じタブで選んだ固定の期間は、再読み込みしても URL から復元する", () => {
    const fixed = { mode: "absolute" as const, from: Date.parse("2026-11-02T03:51:00Z"), to: Date.parse("2026-11-02T04:06:00Z") };
    useTimeRangeStore.getState().setRange(fixed);
    useTimeRangeStore.setState({ range: DEFAULT_RANGE });

    initTimeRangeFromUrl();

    expect(useTimeRangeStore.getState().range).toEqual(fixed);
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

describe("拡大・移動の履歴（ブラウザの「戻る」で前の範囲に戻る）", () => {
  const HOUR = 60 * 60 * 1000;
  const zoomed = { mode: "absolute" as const, from: Date.parse("2026-11-25T00:00:00Z"), to: Date.parse("2026-11-25T01:00:00Z") };
  const zoomedMore = { mode: "absolute" as const, from: Date.parse("2026-11-25T00:15:00Z"), to: Date.parse("2026-11-25T00:45:00Z") };
  let stop: () => void = () => {};

  /** 「戻る」を押して、popstate が届くまで待つ（jsdom では非同期に届く） */
  async function pressBack() {
    const before = window.location.search;
    window.history.back();
    await vi.waitFor(() => expect(window.location.search).not.toBe(before));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    stop = followBrowserBack();
  });

  afterEach(() => {
    stop();
  });

  it("pushRange は履歴を 1 つ積み、setRange は積まない", () => {
    const length = window.history.length;
    useTimeRangeStore.getState().setRange({ mode: "relative", durationMs: 6 * HOUR });
    expect(window.history.length).toBe(length);
    useTimeRangeStore.getState().pushRange(zoomed);
    expect(window.history.length).toBe(length + 1);
    expect(window.location.search).toContain("from=");
  });

  it("拡大を 2 回したあと「戻る」を押すと、1 つ前の範囲、もう 1 回で最初の範囲に戻る", async () => {
    useTimeRangeStore.getState().setRange({ mode: "relative", durationMs: 6 * HOUR });
    useTimeRangeStore.getState().pushRange(zoomed);
    useTimeRangeStore.getState().pushRange(zoomedMore);

    await pressBack();
    expect(useTimeRangeStore.getState().range).toEqual(zoomed);
    await pressBack();
    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 6 * HOUR });
  });

  it("URL に範囲が無い履歴（ダッシュボードを開いたとき）に戻ったら、最後に見ていた直近の範囲にする", async () => {
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify({ mode: "relative", durationMs: 24 * HOUR }));
    useTimeRangeStore.getState().pushRange(zoomed);

    await pressBack();
    expect(window.location.search).toBe("");
    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 24 * HOUR });
  });

  it("同じ範囲を pushRange しても、履歴は増やさない（拡大の上限に当たったときなど）", () => {
    useTimeRangeStore.getState().pushRange(zoomed);
    const length = window.history.length;
    useTimeRangeStore.getState().pushRange(zoomed);
    expect(window.history.length).toBe(length);
  });

  it("ホイールを続けて回したときは、履歴を 1 つにまとめる（間があいたら、また積む）", () => {
    const now = vi.spyOn(Date, "now");
    const length = window.history.length;
    now.mockReturnValue(1_000_000);
    setRangeByWheel(zoomed);
    now.mockReturnValue(1_000_200);
    setRangeByWheel(zoomedMore);
    expect(window.history.length).toBe(length + 1);
    expect(useTimeRangeStore.getState().range).toEqual(zoomedMore);
    now.mockReturnValue(1_005_000);
    setRangeByWheel(zoomed);
    expect(window.history.length).toBe(length + 2);
    now.mockRestore();
  });

  it("ダッシュボードを閉じた後（登録を外した後）は、「戻る」で範囲を変えない", async () => {
    useTimeRangeStore.getState().pushRange(zoomed);
    useTimeRangeStore.getState().pushRange(zoomedMore);
    stop();

    await pressBack();
    expect(useTimeRangeStore.getState().range).toEqual(zoomedMore);
  });
});
