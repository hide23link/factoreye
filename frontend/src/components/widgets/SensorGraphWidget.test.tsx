import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { SensorGraphWidget } from "./SensorGraphWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
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
});

describe("SensorGraphWidget", () => {
  it("sensorIdがnullのときメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget({ sensorId: null })} />);

    expect(screen.getByText("センサーが設定されていません")).toBeInTheDocument();
  });

  it("ローディング中はローディングメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.fetchSensorReadings).mockReturnValue(new Promise(() => {}));

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget()} />);

    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
  });

  it("データ取得後にセンサー名を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [
        { id: 1, sensorId: "s1", value: 25.0, recordedAt: "2024-01-01T00:30:00.000Z" },
        { id: 2, sensorId: "s1", value: 26.0, recordedAt: "2024-01-01T00:00:00.000Z" },
      ],
      total: 2,
    });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget()} />);

    expect(await screen.findByText(/ライン温度/)).toBeInTheDocument();
  });
});
