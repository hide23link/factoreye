import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { Alarm, Sensor } from "../../types";
import { useTrendCursorStore } from "../../store/useTrendCursorStore";
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
  useTrendCursorStore.getState().clearAll();
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

  it("確認に失敗したとき、理由を表示する（黙って何も起きない状態にしない）", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchAlarms).mockImplementation(async (status) =>
      status === "active" ? { alarms: [criticalAlarm], total: 1 } : { alarms: [], total: 0 },
    );
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.acknowledgeAlarm).mockRejectedValue(new Error("network"));

    renderWithQueryClient(<AlarmAlertWidget />);
    await user.click(await screen.findByRole("button", { name: "確認" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("アラームの確認に失敗しました");
  });

  it("「すべて確認」で、未確認のアラームをまとめて確認する（無いときは押せない）", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchAlarms).mockImplementation(async (status) =>
      status === "active" ? { alarms: [criticalAlarm, warningAlarm], total: 2 } : { alarms: [], total: 0 },
    );
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.acknowledgeAlarm).mockResolvedValue({ ...criticalAlarm, status: "acknowledged" });

    renderWithQueryClient(<AlarmAlertWidget />);

    await user.click(await screen.findByRole("button", { name: "すべて確認" }));

    await waitFor(() => expect(api.acknowledgeAlarm).toHaveBeenCalledTimes(2));
    expect(api.acknowledgeAlarm).toHaveBeenCalledWith("a1", "admin");
    expect(api.acknowledgeAlarm).toHaveBeenCalledWith("a2", "admin");
  });

  it("アラームが無いときは、「すべて確認」を押せない", async () => {
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);

    renderWithQueryClient(<AlarmAlertWidget />);

    expect(await screen.findByRole("button", { name: "すべて確認" })).toBeDisabled();
  });

  it("計器グラフが無い画面では、「カーソルの時刻の値」と色の意味を出さない", async () => {
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);

    renderWithQueryClient(<AlarmAlertWidget />);

    await screen.findByText("現在アラームはありません");
    expect(screen.queryByText("色の意味")).not.toBeInTheDocument();
  });

  it("同じ画面の計器グラフのカーソルが指す時刻の各センサーの値と、色の意味を出す", async () => {
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    const cursor = useTrendCursorStore.getState();
    cursor.setCursor("w1", new Date(2026, 10, 18, 7, 2).getTime(), 3_600_000);
    cursor.setRow("w1", { id: "s1", order: 0, name: "洋室 CO2", unit: "ppm", value: "561", color: "var(--fe-red)" });

    renderWithQueryClient(<AlarmAlertWidget />);

    expect(await screen.findByText("洋室 CO2")).toBeInTheDocument();
    expect(screen.getByText("561")).toBeInTheDocument();
    // 計器グラフが 1 時間の表示（点の間隔 7.2 秒）なので、カーソルの札と同じく秒まで出す
    expect(screen.getByText("07:02:00")).toBeInTheDocument();
    expect(screen.getByText("色の意味")).toBeInTheDocument();
    expect(screen.getByText(/水色\s*しきい値/)).toBeInTheDocument();
  });

  it("計器グラフが 2 つあるときは、先に表示された方のカーソルの値を出す", async () => {
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    const cursor = useTrendCursorStore.getState();
    cursor.setCursor("w1", new Date(2026, 10, 18, 7, 2).getTime(), 3_600_000);
    cursor.setRow("w1", { id: "s1", order: 0, name: "先のセンサー", unit: "ppm", value: "1", color: "var(--fe-ink)" });
    cursor.setCursor("w2", new Date(2026, 10, 18, 8, 0).getTime(), 3_600_000);
    cursor.setRow("w2", { id: "s2", order: 0, name: "後のセンサー", unit: "ppm", value: "2", color: "var(--fe-ink)" });

    renderWithQueryClient(<AlarmAlertWidget />);

    expect(await screen.findByText("先のセンサー")).toBeInTheDocument();
    expect(screen.queryByText("後のセンサー")).not.toBeInTheDocument();
  });
});
