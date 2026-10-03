import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { Alarm, Sensor } from "../../types";
import { AlarmAlertWidget } from "./AlarmAlertWidget";

vi.mock("../../lib/api", () => ({
  fetchAlarms: vi.fn(),
  fetchSensors: vi.fn(),
  acknowledgeAlarm: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "圧力計A",
  ingestKey: "pressure-a",
  unit: "MPa",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: 10,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const criticalAlarm: Alarm = {
  id: "a1",
  sensorId: "s1",
  triggeredAt: "2024-01-01T00:00:00.000Z",
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  value: 15.0,
  status: "active",
  thresholdBreached: "max",
  severity: "critical",
};

const warningAlarm: Alarm = {
  id: "a2",
  sensorId: "s1",
  triggeredAt: "2024-01-01T00:00:00.000Z",
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  value: 8.0,
  status: "active",
  thresholdBreached: "max",
  severity: "warning",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AlarmAlertWidget", () => {
  it("アラームがないとき正常メッセージを表示する", async () => {
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);

    renderWithQueryClient(<AlarmAlertWidget />);

    expect(await screen.findByText("現在アラームはありません")).toBeInTheDocument();
  });

  it("重故障アラームをセンサー名と値で表示する", async () => {
    vi.mocked(api.fetchAlarms)
      .mockResolvedValueOnce({ alarms: [criticalAlarm], total: 1 })
      .mockResolvedValueOnce({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);

    renderWithQueryClient(<AlarmAlertWidget />);

    expect(await screen.findByText(/圧力計A/)).toBeInTheDocument();
    expect(screen.getByText(/15/)).toBeInTheDocument();
    expect(screen.getByText(/上限超過/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "確認" })).toBeInTheDocument();
  });

  it("軽故障アラームを表示する", async () => {
    vi.mocked(api.fetchAlarms)
      .mockResolvedValueOnce({ alarms: [warningAlarm], total: 1 })
      .mockResolvedValueOnce({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);

    renderWithQueryClient(<AlarmAlertWidget />);

    expect(await screen.findByText(/圧力計A/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "確認" })).toBeInTheDocument();
  });

  it("確認ボタンを押すとacknowledgeAlarmを呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchAlarms)
      .mockResolvedValueOnce({ alarms: [criticalAlarm], total: 1 })
      .mockResolvedValueOnce({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.acknowledgeAlarm).mockResolvedValue({
      ...criticalAlarm,
      status: "acknowledged",
    });

    renderWithQueryClient(<AlarmAlertWidget />);

    await user.click(await screen.findByRole("button", { name: "確認" }));

    await waitFor(() =>
      expect(api.acknowledgeAlarm).toHaveBeenCalledWith("a1", "admin"),
    );
  });

  it("確認済みアラームには確認済みバッジを表示する", async () => {
    const ackedAlarm: Alarm = {
      ...criticalAlarm,
      status: "acknowledged",
      acknowledgedAt: "2024-01-01T01:00:00.000Z",
      acknowledgedBy: "admin",
    };
    vi.mocked(api.fetchAlarms)
      .mockResolvedValueOnce({ alarms: [], total: 0 })
      .mockResolvedValueOnce({ alarms: [ackedAlarm], total: 1 });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);

    renderWithQueryClient(<AlarmAlertWidget />);

    expect(await screen.findByText("確認済み")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "確認" })).not.toBeInTheDocument();
  });
});
