/**
 * 比較グラフの取り直しの回数のテスト（毎秒の取得や描き直しが起きないことを確かめる）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient } from "../../test/test-utils";
import { DEFAULT_RANGE } from "../../lib/timeRange";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import type { Sensor, Widget } from "../../types";
import { MultiSensorComparisonWidget } from "./MultiSensorComparisonWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

import * as api from "../../lib/api";

function makeSensor(id: string): Sensor {
  return {
    id,
    name: `センサー${id}`,
    ingestKey: id,
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
}

const widget: Widget = {
  id: "w1",
  dashboardId: "d1",
  sensorId: null,
  type: "MultiSensorComparison",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 6,
  gridHeight: 6,
  config: { sensorIds: ["s1", "s2"] },
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

describe("MultiSensorComparisonWidget（直近モードの取り直し）", () => {
  it("12 秒間で、センサーごとの取得は 4 回以下（2 センサーで合計 8 回以下）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("s1"), makeSensor("s2")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [],
    });

    renderWithQueryClient(<MultiSensorComparisonWidget widget={widget} />);
    await vi.advanceTimersByTimeAsync(12_000);

    const calls = vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.length;
    expect(calls).toBeLessThanOrEqual(8);
  });
});
