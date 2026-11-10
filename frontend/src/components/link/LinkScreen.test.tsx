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
