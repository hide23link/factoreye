import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { act, fireEvent, renderWithQueryClient, screen, waitFor, within } from "../../test/test-utils";
import type { DashboardDetail, Sensor, Widget } from "../../types";
import { DashboardLinkView } from "./DashboardLinkView";
import { SETTLE_MS } from "../../hooks/useLinkView";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

import * as api from "../../lib/api";

function makeWidget(id: string, overrides: Partial<Widget> = {}): Widget {
  return {
    id,
    dashboardId: "d1",
    sensorId: "s1",
    type: "SensorGraph",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 6,
    config: { title: id },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// 並び順を確かめるため、サーバーが返す順を、置いた位置の順と変えておく
const dashboard: DashboardDetail = {
  id: "d1",
  name: "第2工場",
  description: null,
  layoutConfig: {},
  widgets: [
    makeWidget("ライン2 電流", { gridRow: 7, gridColumn: 1 }),
    makeWidget("平面図", { type: "FloorPlan", gridRow: 3, gridColumn: 1 }),
    makeWidget("ライン1 電力", { gridRow: 1, gridColumn: 1 }),
    makeWidget("機器ツリー", { type: "DeviceTree", gridRow: 4, gridColumn: 1 }),
    makeWidget("温度", { type: "StatValue", gridRow: 1, gridColumn: 7 }),
  ],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const timeButton = () => screen.getByRole("button", { name: "時刻を指定" });
const fetchCount = () => vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.length;
const initialRange = useTimeRangeStore.getState().range;

beforeEach(() => {
  vi.mocked(api.fetchSensors).mockResolvedValue([{ id: "s1", name: "電力", unit: "kW" } as Sensor]);
  vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 } as never);
  vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
    bucketSeconds: 60,
    buckets: [{ start: new Date(Date.now() - 60_000).toISOString(), avg: 23.4, min: 23, max: 24, count: 1 }],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("DashboardLinkView の並び", () => {
  it("置いた位置の順に並べ、平面図・機器ツリーは出さない", async () => {
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);

    const names = (await screen.findAllByRole("region")).map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["ライン1 電力", "温度", "ライン2 電流"]);
    expect(screen.queryByText("平面図")).not.toBeInTheDocument();
    expect(screen.getByText("第2工場")).toBeInTheDocument();
  });

  it("グラフは 1 列を使い切り（横向きは半分）、小さい部品は 2 列の 1 つ分", async () => {
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);

    const regions = await screen.findAllByRole("region");
    expect(regions[0].className).toContain("col-span-2");
    expect(regions[0].className).toContain("landscape:col-span-1");
    expect(regions[1].className).not.toContain("col-span-2");
  });

  it("表示できる部品が無いときは、その旨を出す", () => {
    renderWithQueryClient(<DashboardLinkView dashboard={{ ...dashboard, widgets: [makeWidget("x", { type: "FloorPlan" })] }} rangeMinutes={30} />);
    expect(screen.getByText("このダッシュボードには、表示できる部品がありません。")).toBeInTheDocument();
  });
});

describe("DashboardLinkView の期間（全グラフ共通・保存しない）", () => {
  it("リンクの期間で開き、10 分〜24 時間のボタンと ＋／－ がある。高さは 32px 以上（min-h-8）", () => {
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);

    expect(timeButton()).toHaveTextContent("直近 30 分");
    const group = screen.getByRole("group", { name: "期間" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "－", "＋", "10 分", "30 分", "1 時間", "3 時間", "8 時間", "24 時間",
    ]);
    for (const button of within(group).getAllByRole("button")) expect(button.className).toContain("min-h-8");
  });

  it("ボタンで変えた期間は保存しない（localStorage・URL・ダッシュボードの期間はそのまま）。「今に戻る」でリンクの設定へ", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?dashboard=d1&range=30m");
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);

    expect(screen.queryByRole("button", { name: "今に戻る" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "3 時間" }));
    expect(screen.getByRole("button", { name: "今に戻る" }).className).toContain("min-h-8");
    expect(timeButton()).toHaveTextContent("直近 3 時間");
    expect(localStorage.getItem("factoreye_time_range")).toBeNull();
    expect(window.location.search).toBe("?dashboard=d1&range=30m");
    expect(useTimeRangeStore.getState().range).toBe(initialRange);

    await user.click(screen.getByRole("button", { name: "今に戻る" }));
    expect(timeButton()).toHaveTextContent("直近 30 分");
  });

  it("＋で半分、－で 2 倍（1 段ずつ）", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={60} />);

    await user.click(screen.getByRole("button", { name: /^拡大/ }));
    expect(timeButton()).toHaveTextContent("直近 30 分");
    await user.click(screen.getByRole("button", { name: /^縮小/ }));
    await user.click(screen.getByRole("button", { name: /^縮小/ }));
    expect(timeButton()).toHaveTextContent("直近 2 時間");
  });

  it("続けて押しても、取得は押し終わって 0.3 秒たってから 1 回分だけ（グラフごとに 1 回）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={60} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const before = fetchCount();
      expect(before).toBe(1); // 同じセンサー・同じ範囲は 1 回（グラフ 2 つで共有）

      for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: /^縮小/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchCount()).toBe(before);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
      });
      expect(fetchCount()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DashboardLinkView の指の操作", () => {
  it("一覧は touch-action: pan-y（縦はスクロール、ブラウザの拡大はしない）", () => {
    const { container } = renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);
    expect((container.firstChild as HTMLElement).style.touchAction).toBe("pan-y");
  });

  it("グラフの枠まで含めて、実効の touch-action が pan-y（グラフの上からも縦にスクロールできる）。ルートだけ見ない", async () => {
    const { container } = renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);
    await screen.findAllByRole("region");
    // グラフの枠（データを読み込んだあとに出る）が、全グラフで出るまで待つ
    await waitFor(() => expect(container.querySelectorAll("[data-link-graph] [style*='touch-action']")).toHaveLength(2));
    // touch-action は祖先との積。グラフの枠の中から根まで、none が 1 つも無いこと
    const boxes = container.querySelectorAll<HTMLElement>("[data-link-graph]");
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      const touchActions: string[] = [];
      for (let el: HTMLElement | null = box; el; el = el.parentElement) {
        if (el.style.touchAction) touchActions.push(el.style.touchAction);
      }
      // グラフの枠の中（SensorGraphWidget・MultiSensorComparisonWidget が recharts の外側に付ける要素）も数える
      box.querySelectorAll<HTMLElement>("*").forEach((el) => el.style.touchAction && touchActions.push(el.style.touchAction));
      expect(touchActions.length).toBeGreaterThan(1); // 根と、グラフの中の枠の両方に指定がある
      expect(touchActions).not.toContain("none");
      expect(touchActions.every((v) => v === "pan-y")).toBe(true);
    }
  });

  it("横になぞると全グラフの期間（上の表示）が動き、ダブルタップでリンクの設定に戻る。縦では動かない", async () => {
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);
    const card = (await screen.findAllByRole("region"))[0];

    fireEvent.pointerDown(card, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 102, clientY: 200 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 102, clientY: 200 });
    expect(timeButton()).toHaveTextContent("直近 30 分");

    fireEvent.pointerDown(card, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 200, clientY: 102 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 200, clientY: 102 });
    expect(timeButton()).not.toHaveTextContent("直近");
    expect(screen.getByRole("button", { name: "今に戻る" })).toBeInTheDocument();

    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(card, { pointerId: 1, clientX: 50, clientY: 50 });
      fireEvent.pointerUp(card, { pointerId: 1, clientX: 50, clientY: 50 });
    }
    expect(timeButton()).toHaveTextContent("直近 30 分");
    expect(screen.getByText("リンクの設定に戻しました")).toBeInTheDocument();
  });

  it("タップすると、全グラフにその時刻の値が出る", async () => {
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);
    const card = (await screen.findAllByRole("region"))[0];

    fireEvent.pointerDown(card, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 50, clientY: 50 });
    expect(screen.getAllByText(/の値$/)).toHaveLength(2); // グラフ 2 つ
  });
});

describe("DashboardLinkView の 1 グラフ表示", () => {
  it("一覧に戻ったとき、⤢で移る前のスクロール位置に戻す", async () => {
    const user = userEvent.setup();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);
    const open = await screen.findByRole("button", { name: "ライン2 電流 を 1 画面で開く" });
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });
    await user.click(open);
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    await user.click(screen.getByRole("button", { name: "← 戻る" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(scrollTo).toHaveBeenCalledWith(0, 300);
  });

  it("ページ全体（html）のスクロールの端に overscroll-behavior-y: contain を付け、外れたら戻す", () => {
    const { unmount } = renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);
    expect(document.documentElement.style.overscrollBehaviorY).toBe("contain");
    unmount();
    expect(document.documentElement.style.overscrollBehaviorY).toBe("");
  });

  it("再読込のあと（履歴に前の印が残っている）は、一覧から始まり、印を消す。そのあと開いて「戻る」で一覧に戻れる", async () => {
    const user = userEvent.setup();
    window.history.replaceState({ linkFocus: "00000000-0000-4000-8000-000000000003" }, "", "/?dashboard=d1&range=30m");
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);
    expect(await screen.findAllByRole("region")).toHaveLength(3);
    expect(window.history.state).toBeNull();

    await user.click(screen.getByRole("button", { name: "ライン1 電力 を 1 画面で開く" }));
    await user.click(screen.getByRole("button", { name: "← 戻る" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getAllByRole("region")).toHaveLength(3);
  });

  it("履歴の印が今のグラフのものでないとき（進む・別の履歴）は、戻るで履歴を戻さず、その場で一覧に戻る", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);
    await user.click(await screen.findByRole("button", { name: "ライン1 電力 を 1 画面で開く" }));
    // 印が別のグラフのものになった（例: Safari の「進む」で別の項目に来た）
    window.history.replaceState({ linkFocus: "other" }, "", window.location.href);
    await user.click(screen.getByRole("button", { name: "← 戻る" }));
    expect(screen.getAllByRole("region")).toHaveLength(3);
  });

  it("⤢で 1 グラフの画面へ（URL は変えない）。「戻る」・画面の戻るボタンで一覧へ。期間は一覧が覚えている", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?dashboard=d1&range=30m");
    renderWithQueryClient(<DashboardLinkView dashboard={dashboard} rangeMinutes={30} />);

    await user.click(screen.getByRole("button", { name: "3 時間" }));
    await user.click(await screen.findByRole("button", { name: "ライン1 電力 を 1 画面で開く" }));
    expect(screen.getByRole("button", { name: "← 戻る" })).toBeInTheDocument();
    expect(screen.getByLabelText(/グラフ。上下になぞると/)).toBeInTheDocument();
    expect(window.location.search).toBe("?dashboard=d1&range=30m");

    await user.click(screen.getByRole("button", { name: "← 戻る" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20)); // history.back() の popstate を待つ
    });
    expect(screen.getAllByRole("region")).toHaveLength(3);
    expect(timeButton()).toHaveTextContent("直近 3 時間");

    // 画面の戻るボタン（popstate）でも一覧へ
    await user.click(screen.getByRole("button", { name: "ライン2 電流 を 1 画面で開く" }));
    expect(screen.getByRole("button", { name: "← 戻る" })).toBeInTheDocument();
    act(() => {
      window.history.back();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getAllByRole("region")).toHaveLength(3);
    expect(window.location.search).toBe("?dashboard=d1&range=30m");
  });
});
