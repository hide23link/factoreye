import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import { useUiStore } from "../store/useUiStore";
import type { Sensor } from "../types";
import { NewSensorNotice } from "./NewSensorNotice";

vi.mock("../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchDashboard: vi.fn(),
  fetchDashboards: vi.fn(),
  createDashboard: vi.fn(),
  addWidget: vi.fn(),
}));

import * as api from "../lib/api";

const sensor = (id: string, name: string): Sensor =>
  ({ id, name, ingestKey: id, unit: "℃", enabled: true }) as unknown as Sensor;

const KEY = "factoreye.seenSensorIds";

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ selectedDashboardId: null });
  vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
});

describe("NewSensorNotice", () => {
  it("初回は通知せず、いまのセンサーを見たことにして記録する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "B")]);
    renderWithQueryClient(<NewSensorNotice />);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["a", "b"]));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("見ていないセンサーが現れたら、名前つきで 1 枚出す。「あとで」で閉じ、もう出さない", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "ENV-07")]);
    renderWithQueryClient(<NewSensorNotice />);
    expect(await screen.findByText("新しい機器『ENV-07』から最初のデータが届きました")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "あとで" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["a", "b"]);
  });

  it("複数同時に届いたら、1 枚にまとめる", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "B"), sensor("c", "C")]);
    renderWithQueryClient(<NewSensorNotice />);
    expect(await screen.findByText("新しい機器 2 台から最初のデータが届きました")).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("開いているダッシュボードにグラフを足す", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    useUiStore.setState({ selectedDashboardId: "d1" });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "B")]);
    vi.mocked(api.fetchDashboard).mockResolvedValue({ id: "d1", widgets: [] } as never);
    vi.mocked(api.addWidget).mockResolvedValue({ id: "w1", gridColumn: 1, gridRow: 1, gridWidth: 6, gridHeight: 7 } as never);
    renderWithQueryClient(<NewSensorNotice />);
    await userEvent.click(await screen.findByRole("button", { name: "ダッシュボードに追加" }));
    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.addWidget).mock.calls[0][0]).toBe("d1");
    expect(vi.mocked(api.addWidget).mock.calls[0][1]).toMatchObject({ type: "SensorGraph", sensorId: "b" });
    expect(api.createDashboard).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("ダッシュボードが開いていなければ、新しく作って足す", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "B")]);
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockResolvedValue({ id: "d9" } as never);
    vi.mocked(api.addWidget).mockResolvedValue({ id: "w1", gridColumn: 1, gridRow: 1, gridWidth: 6, gridHeight: 7 } as never);
    renderWithQueryClient(<NewSensorNotice />);
    await userEvent.click(await screen.findByRole("button", { name: "ダッシュボードに追加" }));
    await waitFor(() => expect(api.createDashboard).toHaveBeenCalled());
    await waitFor(() => expect(useUiStore.getState().selectedDashboardId).toBe("d9"));
  });
});
