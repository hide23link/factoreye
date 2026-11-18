import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../test/test-utils";
import type { Alarm, Sensor } from "../types";
import { OverviewPage } from "./OverviewPage";

vi.mock("../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchLatestReadings: vi.fn(),
  fetchAlarms: vi.fn(),
  fetchDashboards: vi.fn(),
  fetchDashboard: vi.fn(),
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

beforeEach(() => {
  vi.mocked(api.fetchDashboards).mockResolvedValue([]);
});

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

  it("値は単位ごとの桁で出し、経過は短い文字（12s）。正常は 4 台まででたたみ、「ほか N 台」で全部出す", async () => {
    const sensors = Array.from({ length: 6 }, (_, i) => sensor(`s${i}`, `温度${i}`, { unit: "%", deviceId: `d${i}`, deviceName: `env-${i}` }));
    vi.mocked(api.fetchSensors).mockResolvedValue(sensors);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({
      readings: sensors.map((s) => ({ sensorId: s.id, value: 49.84, recordedAt: new Date(Date.now() - 12_000).toISOString() })),
      total: 6,
    });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<OverviewPage />);

    // 狭い幅（上の帯に出ない）でも、画面の名前と「機器 N · センサー M」が本文に出る
    expect(await screen.findByRole("heading", { level: 1, name: /全体監視\s*機器 6 · センサー 6/ })).toBeInTheDocument();
    expect((await screen.findAllByText("50%")).length).toBe(4);
    expect(screen.queryByText("49.84%")).not.toBeInTheDocument();
    expect(screen.getAllByText("12s").length).toBe(4);
    expect(screen.queryByText("env-5")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ほか 2 台" }));
    expect(screen.getByText("env-5")).toBeInTheDocument();
  });

  it("センサーが無ければ、セットアップガイドへ案内する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<OverviewPage />);

    expect(await screen.findByText(/センサーがまだありません/)).toBeInTheDocument();
  });

  it("配置図のウィジェットが無ければ、置き方を小さく案内する（大きな枠は出さない）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("t", "温度", { unit: "℃" })]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [{ sensorId: "t", value: 20, recordedAt: new Date().toISOString() }], total: 1 });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<OverviewPage />);

    expect(await screen.findByText(/「配置図」のウィジェットを置くと/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "配置図の枠" })).not.toBeInTheDocument();
  });

  it("どれかのダッシュボードに配置図のウィジェットがあれば、全部取れてから、その配置図を出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("t", "温度", { unit: "℃" })]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [{ sensorId: "t", value: 20, recordedAt: new Date().toISOString() }], total: 1 });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchDashboards).mockResolvedValue([
      { id: "d1", name: "A", description: null, layoutConfig: {}, createdAt: "", updatedAt: "" },
      { id: "d2", name: "B", description: null, layoutConfig: {}, createdAt: "", updatedAt: "" },
    ]);
    vi.mocked(api.fetchDashboard).mockImplementation((id: string) =>
      Promise.resolve({
        id,
        name: id,
        description: null,
        layoutConfig: {},
        createdAt: "",
        updatedAt: "",
        widgets:
          id === "d2"
            ? [{ id: "w1", dashboardId: "d2", sensorId: null, type: "FloorPlan" as const, gridColumn: 1, gridRow: 1, gridWidth: 8, gridHeight: 9, config: {}, createdAt: "", updatedAt: "" }]
            : [],
      }),
    );

    renderWithQueryClient(<OverviewPage />);

    expect(await screen.findByRole("group", { name: "配置図" })).toBeInTheDocument();
  });
});
