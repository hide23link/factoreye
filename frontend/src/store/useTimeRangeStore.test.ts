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

  it("ホーム画面のショートカットなどで開いた URL の固定の期間は使わず、URL の固定の期間を消して、最後の直近の範囲で開く（URL はその範囲に書き換える）", () => {
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify({ mode: "relative", durationMs: 6 * 60 * 60 * 1000 }));
    setUrl("?from=2026-11-02T03:51:00.000Z&to=2026-11-02T04:06:00.000Z");

    initTimeRangeFromUrl();

    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 6 * 60 * 60 * 1000 });
    expect(window.location.search).toBe("?range=6h");
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

describe("範囲の履歴（ブラウザの「戻る」で前の範囲に戻る）", () => {
  const HOUR = 60 * 60 * 1000;
  const zoomed = { mode: "absolute" as const, from: Date.parse("2026-11-25T00:00:00Z"), to: Date.parse("2026-11-25T01:00:00Z") };
  const zoomedMore = { mode: "absolute" as const, from: Date.parse("2026-11-25T00:15:00Z"), to: Date.parse("2026-11-25T00:45:00Z") };
  const zoomedMost = { mode: "absolute" as const, from: Date.parse("2026-11-25T00:20:00Z"), to: Date.parse("2026-11-25T00:30:00Z") };
  // 「戻る」でダッシュボードを開いた記録。開くときは、画面（DashboardView）と同じく initTimeRangeFromUrl を呼ぶ
  let opened: string[] = [];
  let stop: () => void = () => {};

  /** 「戻る」を押して、popstate が届くまで待つ（jsdom では非同期に届く） */
  async function pressBack() {
    const before = window.location.href;
    window.history.back();
    await vi.waitFor(() => expect(window.location.href).not.toBe(before));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    opened = [];
    stop = followBrowserBack((dashboardId) => {
      opened.push(dashboardId);
      initTimeRangeFromUrl(dashboardId);
    });
    initTimeRangeFromUrl("d1");
  });

  afterEach(() => {
    stop();
    resetTimeRange("d1");
  });

  it("pushRange は履歴を 1 つ積み、setRange は積まない", () => {
    const length = window.history.length;
    useTimeRangeStore.getState().setRange({ mode: "relative", durationMs: 6 * HOUR });
    expect(window.history.length).toBe(length);
    useTimeRangeStore.getState().pushRange(zoomed);
    expect(window.history.length).toBe(length + 1);
    expect(window.location.search).toContain("from=");
  });

  it("拡大を 2 回したあと「戻る」を押すと、1 つ前の範囲、もう 1 回で最初の範囲に戻る（ダッシュボードは開き直さない）", async () => {
    useTimeRangeStore.getState().setRange({ mode: "relative", durationMs: 6 * HOUR });
    useTimeRangeStore.getState().pushRange(zoomed);
    useTimeRangeStore.getState().pushRange(zoomedMore);

    await pressBack();
    expect(useTimeRangeStore.getState().range).toEqual(zoomed);
    await pressBack();
    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 6 * HOUR });
    expect(opened).toEqual([]);
  });

  it("開いたときの範囲を、今の履歴の URL に書く（印も付ける）", () => {
    expect(window.location.search).toBe("?range=1h");
    expect(window.history.state).toEqual({ factoreyeDashboard: "d1" });
  });

  it("6 時間で開く → 24 時間 → 「戻る」で 6 時間に戻る（直近の範囲どうしでも、開いたときの範囲へ戻れる）", async () => {
    resetTimeRange("d1");
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify({ mode: "relative", durationMs: 6 * HOUR }));
    initTimeRangeFromUrl("d1");
    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 6 * HOUR });

    useTimeRangeStore.getState().pushRange({ mode: "relative", durationMs: 24 * HOUR });
    await pressBack();

    expect(window.location.search).toBe("?range=6h");
    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 6 * HOUR });
  });

  it("URL に範囲が無い履歴（以前の版で開いた履歴など）に戻ったら、最後に見ていた直近の範囲にする", async () => {
    window.history.replaceState({ factoreyeDashboard: "d1" }, "", "/dashboards/1");
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify({ mode: "relative", durationMs: 24 * HOUR }));
    useTimeRangeStore.getState().pushRange(zoomed);

    await pressBack();
    expect(window.location.search).toBe("");
    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 24 * HOUR });
  });

  it("開く→3 回拡大→別の画面へ→「戻る」1 回で、ダッシュボードに帰る（範囲は 2 回目の拡大）", async () => {
    useTimeRangeStore.getState().pushRange(zoomed);
    useTimeRangeStore.getState().pushRange(zoomedMore);
    useTimeRangeStore.getState().pushRange(zoomedMost);
    // 設定などの画面へ移る（画面の切り替えは URL を変えない。ダッシュボードを閉じる）
    resetTimeRange("d1");
    expect(window.location.search).toBe("");

    await pressBack();
    expect(opened).toEqual(["d1"]);
    expect(useTimeRangeStore.getState().range).toEqual(zoomedMore);
  });

  it("別のダッシュボード（d2）へ移った後の「戻る」は、d1 を開き直し、d1 の範囲にする", async () => {
    useTimeRangeStore.getState().pushRange(zoomed);
    useTimeRangeStore.getState().pushRange(zoomedMore);
    // d2 へ移る（d1 を閉じて d2 を開く）
    resetTimeRange("d1");
    initTimeRangeFromUrl("d2");

    await pressBack();
    // 画面では、d2 を閉じてから d1 を開く。移った先の履歴（d1 の範囲）は消さない
    resetTimeRange("d2");
    initTimeRangeFromUrl("d1");
    expect(opened).toEqual(["d1"]);
    expect(useTimeRangeStore.getState().range).toEqual(zoomed);
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

  it("印の無い履歴（アプリのほかの画面）に戻っても、何もしない", async () => {
    window.history.replaceState(null, "", "/dashboards/1?other=1");
    window.history.pushState(null, "", "/dashboards/1?other=2");
    await pressBack();
    expect(opened).toEqual([]);
  });
});
