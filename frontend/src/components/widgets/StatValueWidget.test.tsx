import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Reading, Sensor, Widget } from "../../types";
import { StatValueWidget } from "./StatValueWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "冷蔵庫温度",
  ingestKey: "fridge-temp",
  unit: "°C",
  thresholdMinWarning: 2,
  thresholdMinCritical: 0,
  thresholdMaxWarning: 8,
  thresholdMaxCritical: 10,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function makeReading(value: number): Reading {
  return { id: 1, sensorId: "s1", value, recordedAt: "2024-01-01T00:00:00.000Z" };
}

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: "s1",
    type: "StatValue",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 4,
    gridHeight: 4,
    config: { timeRangeHours: 1, decimals: 1 },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StatValueWidget", () => {
  it("sensorIdがnullのときメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });

    renderWithQueryClient(<StatValueWidget widget={makeWidget({ sensorId: null })} />);

    expect(screen.getByText("センサーが設定されていません")).toBeInTheDocument();
  });

  it("正常値はセンサー名・値・単位を通常スタイルで表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [makeReading(5.0)],
      total: 1,
    });

    renderWithQueryClient(<StatValueWidget widget={makeWidget()} />);

    expect(await screen.findByText("冷蔵庫温度")).toBeInTheDocument();
    expect(screen.getByText("5.0")).toBeInTheDocument();
    expect(screen.getByText("°C")).toBeInTheDocument();
  });

  it("軽故障しきい値超過のとき警告ラベルを表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [makeReading(9.0)], // thresholdMaxWarning=8 超過
      total: 1,
    });

    renderWithQueryClient(<StatValueWidget widget={makeWidget()} />);

    expect(await screen.findByText(/軽故障しきい値超過/)).toBeInTheDocument();
  });

  it("重故障しきい値超過のとき重故障ラベルを表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [makeReading(12.0)], // thresholdMaxCritical=10 超過
      total: 1,
    });

    renderWithQueryClient(<StatValueWidget widget={makeWidget()} />);

    expect(await screen.findByText(/重故障しきい値超過/)).toBeInTheDocument();
  });

  it("下限を下回る重故障のとき重故障ラベルを表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [makeReading(-1.0)], // thresholdMinCritical=0 未満
      total: 1,
    });

    renderWithQueryClient(<StatValueWidget widget={makeWidget()} />);

    expect(await screen.findByText(/重故障しきい値超過/)).toBeInTheDocument();
  });
});
