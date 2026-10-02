import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { ProductionStatusWidget } from "./ProductionStatusWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchSensorReadingsAggregate: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "テスト機械1号機 生産数",
  ingestKey: "machine1-production",
  unit: "個",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: null,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function makeWidget(config: Widget["config"] = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: "s1",
    type: "ProductionStatus",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 4,
    gridHeight: 4,
    config,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProductionStatusWidget", () => {
  it("閾値を超えていれば稼働中、直近1時間/本日累計を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [{ id: 1, sensorId: "s1", value: 5, recordedAt: "2024-01-01T00:00:00.000Z" }],
      total: 1,
    });
    vi.mocked(api.fetchSensorReadingsAggregate)
      .mockResolvedValueOnce({ sum: 42, count: 10 }) // 直近1時間
      .mockResolvedValueOnce({ sum: 300, count: 50 }); // 本日累計

    renderWithQueryClient(<ProductionStatusWidget widget={makeWidget({ onThreshold: 0 })} />);

    expect(await screen.findByText("稼働中")).toBeInTheDocument();
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(await screen.findByText("300")).toBeInTheDocument();
  });

  it("dailyTarget未設定時は達成率を表示しない", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchSensorReadingsAggregate).mockResolvedValue({ sum: 0, count: 0 });

    renderWithQueryClient(<ProductionStatusWidget widget={makeWidget()} />);

    await screen.findByText("停止中");
    expect(screen.queryByText(/目標達成率/)).not.toBeInTheDocument();
  });

  it("dailyTarget設定時は達成率を計算して表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchSensorReadingsAggregate)
      .mockResolvedValueOnce({ sum: 0, count: 0 }) // 直近1時間
      .mockResolvedValueOnce({ sum: 50, count: 10 }); // 本日累計

    renderWithQueryClient(
      <ProductionStatusWidget widget={makeWidget({ dailyTarget: 200 })} />,
    );

    expect(await screen.findByText(/目標達成率: 25%/)).toBeInTheDocument();
  });

  it("センサー未設定ならメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);

    renderWithQueryClient(
      <ProductionStatusWidget widget={{ ...makeWidget(), sensorId: null }} />,
    );
    expect(screen.getByText("センサーが設定されていません")).toBeInTheDocument();
  });
});
