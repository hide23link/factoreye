import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, fireEvent, renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { LinkScreen, SETTLE_MS } from "./LinkScreen";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

import * as api from "../../lib/api";

const widget: Widget = {
  id: "w1",
  dashboardId: "d1",
  sensorId: "s1",
  type: "SensorGraph",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 6,
  gridHeight: 6,
  config: { title: "温度・湿度", sensorIds: ["s1", "s2"] },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const fetchCount = () => vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.length;
/** 読み込みの Promise を進める（偽のタイマーのまま） */
const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.mocked(api.fetchSensors).mockResolvedValue([
    { id: "s1", name: "温度", unit: "℃" } as Sensor,
    { id: "s2", name: "湿度", unit: "%" } as Sensor,
  ]);
  vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LinkScreen の取得の数", () => {
  it("指を動かしている間は取り直さず、離して少ししてから 1 回だけ取る（センサーごとに 1 回）", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();
    const before = fetchCount();
    expect(before).toBe(2); // 2 センサー × 1 回（グラフと今の値で、取得は共有される）

    const chart = screen.getByLabelText(/グラフ。上下になぞると/);
    fireEvent.pointerDown(chart, { pointerId: 1, clientX: 100, clientY: 100 });
    for (let i = 1; i <= 60; i++) {
      fireEvent.pointerMove(chart, { pointerId: 1, clientX: 100, clientY: 100 + i * 3 });
      await flush();
    }
    expect(screen.getByRole("button", { name: "時刻を指定" }).textContent).not.toContain("直近 30 分"); // 表示は動いている
    expect(fetchCount()).toBe(before);

    fireEvent.pointerUp(chart, { pointerId: 1, clientX: 100, clientY: 280 });
    await flush();
    expect(fetchCount()).toBe(before); // 離した直後は、まだ取らない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    });
    expect(fetchCount()).toBe(before + 2);
  });
});

describe("LinkScreen の時刻の指定", () => {
  // 例の「今」（端末の時刻で 2026-11-10 11:30）
  const NOW = new Date(2026, 10, 10, 11, 30);
  const timeButton = () => screen.getByRole("button", { name: "時刻を指定" });
  const sheet = () => screen.queryByRole("dialog", { name: "この時刻から表示" });

  beforeEach(() => {
    vi.setSystemTime(NOW);
    localStorage.clear();
    sessionStorage.clear();
  });

  it("日付を押すと「その日＋① の時刻」から、長さはそのままで表示し、シートを閉じる。今日でない日は日付つきで知らせる", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();

    fireEvent.click(timeButton());
    expect(sheet()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "11月3日 8時00分から" }));
    expect(timeButton()).toHaveTextContent("8:00〜8:30");
    expect(screen.getByText("11/3 8:00 から表示")).toBeInTheDocument();
    expect(sheet()).not.toBeInTheDocument();
  });

  it("近道は押すとすぐ移る。今日なら時刻だけを知らせる", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();

    fireEvent.click(timeButton());
    fireEvent.click(screen.getByRole("button", { name: "1 時間前" }));
    expect(timeButton()).toHaveTextContent("10:30〜11:00");
    expect(screen.getByText("10:30 から表示")).toBeInTheDocument();
    expect(sheet()).not.toBeInTheDocument();
  });

  it("開始＋長さが今を越えるときは、直近の表示にして、そう知らせる", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={180} />);
    await flush();

    fireEvent.click(timeButton());
    fireEvent.click(screen.getByRole("button", { name: "1 時間前" }));
    expect(timeButton()).toHaveTextContent("直近 3 時間");
    expect(screen.getByText("直近 3 時間を表示（今を越えるため）")).toBeInTheDocument();
  });

  it("① の帯では移らない。選んだ時刻は、閉じて開き直しても残る", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();

    fireEvent.click(timeButton());
    const slider = screen.getByRole("slider", { name: "時刻を選ぶ" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(timeButton()).toHaveTextContent("直近 30 分");
    expect(sheet()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(sheet()).not.toBeInTheDocument();
    fireEvent.click(timeButton());
    expect(screen.getByRole("slider", { name: "時刻を選ぶ" })).toHaveAttribute("aria-valuetext", "8:30");
  });

  it("シートを開いている間は、グラフの指の操作を受けない", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();

    fireEvent.click(timeButton());
    const chart = screen.getByLabelText(/グラフ。上下になぞると/);
    fireEvent.pointerDown(chart, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(chart, { pointerId: 1, clientX: 100, clientY: 250 });
    fireEvent.pointerUp(chart, { pointerId: 1, clientX: 100, clientY: 250 });
    expect(timeButton()).toHaveTextContent("直近 30 分");
  });

  it("移った期間は保存しない（localStorage・sessionStorage・URL に書かない）", async () => {
    const searchBefore = window.location.search;
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();

    fireEvent.click(timeButton());
    fireEvent.click(screen.getByRole("button", { name: "11月3日 8時00分から" }));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.search).toBe(searchBefore);
  });

  it("グラフに指を置いたままシートを開いても、離した扱いにする（日付で移ると取り直し、その後の 1 本指の左右ドラッグは移動）", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();
    const before = fetchCount();

    const chart = screen.getByLabelText(/グラフ。上下になぞると/);
    fireEvent.pointerDown(chart, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.click(timeButton()); // 指 1 は置いたまま（離した知らせは来ない）
    fireEvent.click(screen.getByRole("button", { name: "11月3日 8時00分から" }));
    expect(timeButton()).toHaveTextContent("8:00〜8:30");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    });
    expect(fetchCount()).toBe(before + 2);

    // 1 本指で右へなぞる → 長さ 30 分のまま過去へ動く（古い指が残っていると、ピンチ扱いで長さが変わる）
    fireEvent.pointerDown(chart, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(chart, { pointerId: 2, clientX: 250, clientY: 100 });
    fireEvent.pointerUp(chart, { pointerId: 2, clientX: 250, clientY: 100 });
    expect(timeButton()).toHaveTextContent("5:00〜5:30");
  });

  it("シートを開いている間は、ホイールでも拡大・縮小しない", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();

    fireEvent.click(timeButton());
    fireEvent.wheel(screen.getByLabelText(/グラフ。上下になぞると/), { deltaY: 300 });
    expect(timeButton()).toHaveTextContent("直近 30 分");
  });

  it("開くと ✕ にフォーカス、Esc で閉じて 🕘 へ戻す。移った後も 🕘 へ戻す", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();

    fireEvent.click(timeButton());
    expect(screen.getByRole("button", { name: "閉じる" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "閉じる" }), { key: "Escape" });
    expect(sheet()).not.toBeInTheDocument();
    expect(timeButton()).toHaveFocus();

    fireEvent.click(timeButton());
    fireEvent.click(screen.getByRole("button", { name: "昨日 8:00" }));
    expect(timeButton()).toHaveFocus();
  });

  it("「1 時間前」は押した時刻から数える（開いたまま 20 分置いても、ずれない）", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();

    fireEvent.click(timeButton());
    vi.setSystemTime(new Date(2026, 10, 10, 11, 50));
    fireEvent.click(screen.getByRole("button", { name: "1 時間前" }));
    expect(timeButton()).toHaveTextContent("10:50〜11:20");
  });

  it("開いた後に端末の時刻が戻り、押した時刻が未来になったら「まだ来ていない時刻です」で移らない", async () => {
    renderWithQueryClient(<LinkScreen widget={widget} rangeMinutes={30} />);
    await flush();

    fireEvent.click(timeButton());
    vi.setSystemTime(new Date(2026, 10, 10, 7, 30)); // 端末の時計が直された（11:30 → 7:30）
    fireEvent.click(screen.getByRole("button", { name: "11月10日 8時00分から" }));
    expect(screen.getByText("まだ来ていない時刻です")).toBeInTheDocument();
    expect(timeButton()).toHaveTextContent("直近 30 分");
    expect(sheet()).toBeInTheDocument();
  });
});
