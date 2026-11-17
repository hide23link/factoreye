import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../test/test-utils";
import type { Alarm, Sensor } from "../types";
import { OverviewPage } from "./OverviewPage";

vi.mock("../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchLatestReadings: vi.fn(),
  fetchAlarms: vi.fn(),
}));

import * as api from "../lib/api";

function sensor(id: string, name: string, extra: Partial<Sensor> = {}): Sensor {
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
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OverviewPage（全体監視）", () => {
  it("札を警報・正常の欄に分け、記録にアラームを出す", async () => {
    const alarm: Alarm = {
      id: "a1",
      sensorId: "co2",
      triggeredAt: new Date().toISOString(),
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      value: 1050,
      status: "active",
      thresholdBreached: "max",
      severity: "critical",
    };
    vi.mocked(api.fetchSensors).mockResolvedValue([
      sensor("co2", "洋室 CO2", { thresholdMaxCritical: 1000, deviceId: "d1", deviceName: "env-youshitsu" }),
      sensor("t", "リビング 温度", { unit: "℃" }),
    ]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({
      readings: [
        { sensorId: "co2", value: 1050, recordedAt: new Date().toISOString() },
        { sensorId: "t", value: 22.4, recordedAt: new Date().toISOString() },
      ],
      total: 2,
    });
    vi.mocked(api.fetchAlarms).mockImplementation((status?: string) =>
      Promise.resolve(status === "acknowledged" ? { alarms: [], total: 0 } : { alarms: [alarm], total: 1 }),
    );

    renderWithQueryClient(<OverviewPage />);

    expect(await screen.findByText("env-youshitsu")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /警報/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /正常/ })).toBeInTheDocument();
    expect(screen.getByText("洋室 CO2 重故障")).toBeInTheDocument();
    expect(screen.getByText("22.4℃")).toBeInTheDocument();
    // 記録
    expect(screen.getByText(/洋室 CO2 上限超え/)).toBeInTheDocument();
  });

  it("センサーが無ければ、セットアップガイドへ案内する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<OverviewPage />);

    expect(await screen.findByText(/センサーがまだありません/)).toBeInTheDocument();
  });
});
