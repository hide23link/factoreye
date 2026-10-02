import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { Alarm, Sensor } from "../../types";
import { AlarmSettingsPanel } from "./AlarmSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchAlarms: vi.fn(),
  fetchSensors: vi.fn(),
  acknowledgeAlarm: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "圧力計A-1",
  ingestKey: "sensor-abc",
  unit: "MPa",
  thresholdMin: null,
  thresholdMax: 10,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const activeAlarm: Alarm = {
  id: "a1",
  sensorId: "s1",
  triggeredAt: "2024-01-01T00:00:00.000Z",
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  value: 12.5,
  status: "active",
  thresholdBreached: "max",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AlarmSettingsPanel", () => {
  it("デフォルトは「発生中」タブでアラームを表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [activeAlarm], total: 1 });
    renderWithQueryClient(<AlarmSettingsPanel />);

    expect(await screen.findByText("圧力計A-1")).toBeInTheDocument();
    expect(screen.getByText("上限超過")).toBeInTheDocument();
    expect(api.fetchAlarms).toHaveBeenCalledWith("active");
  });

  it("タブを切り替えると対応するstatusでfetchAlarmsを呼び直す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    renderWithQueryClient(<AlarmSettingsPanel />);

    await screen.findByText(/該当するアラームはありません/);
    await user.click(screen.getByRole("button", { name: "すべて" }));

    await waitFor(() => expect(api.fetchAlarms).toHaveBeenCalledWith(undefined));
  });

  it("確認ボタンでacknowledgeAlarmを呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [activeAlarm], total: 1 });
    vi.mocked(api.acknowledgeAlarm).mockResolvedValue({ ...activeAlarm, status: "acknowledged" });
    renderWithQueryClient(<AlarmSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "確認" }));

    expect(api.acknowledgeAlarm).toHaveBeenCalledWith("a1", "admin");
  });
});
