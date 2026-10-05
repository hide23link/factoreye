import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { DEFAULT_RANGE } from "../../lib/timeRange";
import { SensorGraphWidget } from "./SensorGraphWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

vi.mock("../../hooks/useNow", () => ({
  useNow: () => new Date("2024-01-01T01:00:00.000Z").getTime(),
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

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: "s1",
    type: "SensorGraph",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 6,
    config: { timeRangeHours: 1, graphType: "line" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
});

describe("SensorGraphWidget", () => {
  it("sensorIdがnullのときメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 1,
      buckets: [],
    });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget({ sensorId: null })} />);

    expect(screen.getByText("センサーが設定されていません")).toBeInTheDocument();
  });

  it("ローディング中はローディングメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.fetchSensorReadingsDownsampled).mockReturnValue(new Promise(() => {}));

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget()} />);

    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
  });

  it("データ取得後にセンサー名を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [
        { start: "2024-01-01T00:00:00.000Z", min: 25, avg: 25.5, max: 26, count: 2 },
      ],
    });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget()} />);

    expect(await screen.findByText(/ライン温度/)).toBeInTheDocument();
  });

  it("表示範囲は、ダッシュボードの範囲（時間範囲の状態）に従って取得する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [],
    });
    // 固定期間（2024-01-01 00:00〜00:30 UTC）に切り替えておく
    useTimeRangeStore.setState({
      range: {
        mode: "absolute",
        from: Date.parse("2024-01-01T00:00:00.000Z"),
        to: Date.parse("2024-01-01T00:30:00.000Z"),
      },
    });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget()} />);

    await screen.findByText(/ライン温度/);
    expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalledWith(
      "s1",
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:30:00.000Z",
      500,
    );
  });
});
