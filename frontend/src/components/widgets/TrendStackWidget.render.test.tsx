import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import { cancelPendingCursorTime, useCursorTimeStore } from "../../store/useCursorTimeStore";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { useTrendCursorStore } from "../../store/useTrendCursorStore";
import type { Sensor, Widget } from "../../types";
import { TrendStackWidget } from "./TrendStackWidget";

// 重い計算（点・線の形）が何回呼ばれたかを数えるため、lib/trend-stack の関数を、呼び出しを数える形に包む
vi.mock("../../lib/trend-stack", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/trend-stack")>();
  return { ...original, toPoints: vi.fn(original.toPoints), linePath: vi.fn(original.linePath), niceScale: vi.fn(original.niceScale) };
});

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  fetchLatestReadings: vi.fn(),
}));

import * as api from "../../lib/api";
import * as trendStack from "../../lib/trend-stack";

function sensor(id: string, name: string): Sensor {
  return {
    id,
    name,
    ingestKey: id,
    unit: "ppm",
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: null,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "",
    updatedAt: "",
  };
}

const widget: Widget = {
  id: "w1",
  dashboardId: "d1",
  sensorId: "a",
  type: "TrendStack",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 12,
  gridHeight: 10,
  config: { sensorIds: ["a", "b", "c"] },
  createdAt: "",
  updatedAt: "",
};

beforeEach(() => {
  useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 60 * 60_000 } });
  useCursorTimeStore.getState().reset();
  useTrendCursorStore.getState().clearAll();
  vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
});

afterEach(() => {
  cancelPendingCursorTime();
  useCursorTimeStore.getState().reset();
  vi.restoreAllMocks();
});

describe("TrendStackWidget の描き直し（カーソルが動くだけでは、行の重い計算をやり直さない）", () => {
  it("カーソルの時刻が何度変わっても、全行の点・目盛り・線の形の計算は増えない（札だけが動く）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA"), sensor("b", "センサーB"), sensor("c", "センサーC")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: Array.from({ length: 30 }, (_, i) => ({ start: new Date(Date.now() - (40 - i) * 60_000).toISOString(), avg: 500 + i, min: 490 + i, max: 510 + i, count: 5 })),
    });

    renderWithQueryClient(<TrendStackWidget widget={widget} />);
    await screen.findAllByText("センサーC");
    // 3 行ぶんの計算がそろって（センサー名・最新の値が届いて計算し直すぶんも含めて）、落ち着くまで待つ
    await vi.waitFor(() => expect(vi.mocked(trendStack.linePath).mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const before = {
      toPoints: vi.mocked(trendStack.toPoints).mock.calls.length,
      linePath: vi.mocked(trendStack.linePath).mock.calls.length,
      niceScale: vi.mocked(trendStack.niceScale).mock.calls.length,
    };
    const labelBefore = screen.getByTestId("cursor-time-label").textContent;

    // カーソルを 20 回動かす（そのたびに、全行が新しい時刻を受け取る）
    for (let i = 0; i < 20; i++) {
      act(() => useCursorTimeStore.getState().setTime(Date.now() - (50 - i) * 60_000 / 2));
    }

    // 札の時刻は変わった（カーソルは動いている）のに、重い計算は 1 回も増えていない
    expect(screen.getByTestId("cursor-time-label").textContent).not.toBe(labelBefore);
    expect(vi.mocked(trendStack.toPoints).mock.calls.length).toBe(before.toPoints);
    expect(vi.mocked(trendStack.linePath).mock.calls.length).toBe(before.linePath);
    expect(vi.mocked(trendStack.niceScale).mock.calls.length).toBe(before.niceScale);
  });

  it("データが変わったとき（取り直し）は、計算をやり直す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [{ start: new Date(Date.now() - 5 * 60_000).toISOString(), avg: 5, min: 4, max: 6, count: 1 }],
    });

    renderWithQueryClient(<TrendStackWidget widget={{ ...widget, config: { sensorIds: ["a"] } }} />);
    await screen.findAllByText("センサーA");
    await vi.waitFor(() => expect(vi.mocked(trendStack.linePath)).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = vi.mocked(trendStack.linePath).mock.calls.length;

    // 範囲が変わる（期間を 6 時間にする）と、行の計算はやり直す
    act(() => useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 6 * 60 * 60_000 } }));
    await vi.waitFor(() => expect(vi.mocked(trendStack.linePath).mock.calls.length).toBeGreaterThan(before));
  });
});
