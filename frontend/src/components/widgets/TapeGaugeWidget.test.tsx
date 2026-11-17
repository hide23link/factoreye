import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { TapeGaugeWidget } from "./TapeGaugeWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "co2",
  name: "洋室 CO2",
  ingestKey: "co2",
  unit: "ppm",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: 900,
  thresholdMaxCritical: 1000,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "",
  updatedAt: "",
};

const widget = (sensorId: string | null): Widget => ({
  id: "w",
  dashboardId: "d",
  sensorId,
  type: "TapeGauge",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 3,
  gridHeight: 5,
  config: { decimals: 0 },
  createdAt: "",
  updatedAt: "",
});

const reading = (minutesAgo: number, value: number) => ({ sensorId: "co2", value, recordedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() });

afterEach(() => vi.restoreAllMocks());

describe("TapeGaugeWidget（計器）", () => {
  it("センサーが無ければ案内する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<TapeGaugeWidget widget={widget(null)} />);
    expect(screen.getByText("センサーが設定されていません")).toBeInTheDocument();
  });

  it("今の値・1 時間の変化・重故障の外の表示を出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [reading(0, 1050), reading(30, 1000), reading(58, 900)],
      total: 3,
    });
    renderWithQueryClient(<TapeGaugeWidget widget={widget("co2")} />);

    expect(await screen.findByText("1050")).toBeInTheDocument();
    expect(screen.getByText(/重故障のしきい値の外/)).toBeInTheDocument();
    // 58 分で +150 → 約 +155/h
    expect(screen.getByText(/↑155/)).toBeInTheDocument();
  });
});
