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
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: 10,
  thresholdDeadBand: 0,
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
  severity: "critical",
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
    expect(api.fetchAlarms).toHaveBeenCalledWith("active", 100);
  });

  it("タブを切り替えると対応するstatusでfetchAlarmsを呼び直す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    renderWithQueryClient(<AlarmSettingsPanel />);

    await screen.findByText(/該当するアラームはありません/);
    await user.click(screen.getByRole("button", { name: "すべて" }));

    await waitFor(() => expect(api.fetchAlarms).toHaveBeenCalledWith(undefined, 100));
  });

  it("件数が上限を超えるとき、表示件数と全件数を案内する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [activeAlarm], total: 250 });
    renderWithQueryClient(<AlarmSettingsPanel />);

    expect(await screen.findByText(/新しい順に 1 件を表示/)).toBeInTheDocument();
    expect(screen.getByText(/全部で 250 件/)).toBeInTheDocument();
  });

  it("取得に失敗したとき、エラーと再試行を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchAlarms).mockRejectedValue(new Error("boom"));
    renderWithQueryClient(<AlarmSettingsPanel />);

    expect(await screen.findByText("アラームを取得できませんでした。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再試行" })).toBeInTheDocument();
    expect(screen.queryByText("読み込み中...")).not.toBeInTheDocument();
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
