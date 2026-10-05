/**
 * 直近モードの取り直しの回数のテスト（画面が毎秒描き直されないことを確かめる）。
 *
 * 以前は、表示の時刻が毎秒変わり、取得のキーも毎秒変わっていたため、毎秒の取得と
 * 「読み込み中」への差し替えが起きていた。取り直す間隔（5 秒）ごとにだけ取得する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient } from "../../test/test-utils";
import { DEFAULT_RANGE } from "../../lib/timeRange";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import type { Sensor, Widget } from "../../types";
import { SensorGraphWidget } from "./SensorGraphWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "ライン温度",
  ingestKey: "line-temp",
  unit: "°C",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: null,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const widget: Widget = {
  id: "w1",
  dashboardId: "d1",
  sensorId: "s1",
  type: "SensorGraph",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 6,
  gridHeight: 6,
  config: { graphType: "line" },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2024-01-01T01:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
});

describe("SensorGraphWidget（直近モードの取り直し）", () => {
  it("12 秒間で、取得は 4 回以下（毎秒取り直さない）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [],
    });

    renderWithQueryClient(<SensorGraphWidget widget={widget} />);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.length).toBeLessThanOrEqual(4);
  });
});
