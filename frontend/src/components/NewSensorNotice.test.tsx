import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import { useAuthStore } from "../store/useAuthStore";
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

const KEY = "factoreye.seenSensorIds.local";

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ selectedDashboardId: null, kiosk: false });
  useAuthStore.setState({ me: null, impersonation: null });
  vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
  vi.mocked(api.fetchDashboard).mockResolvedValue({ id: "d1", widgets: [] } as never);
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
    expect(await screen.findByText("新しいセンサー『ENV-07』が追加されました。データを待っています")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "あとで" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["a", "b"]);
  });

  it("複数同時に届いたら、1 枚にまとめる", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "B"), sensor("c", "C")]);
    renderWithQueryClient(<NewSensorNotice />);
    expect(await screen.findByText("新しいセンサーが 2 件見つかりました")).toBeTruthy();
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

  it("値が届いているセンサーは「最初のデータが届きました」", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "ENV-07")]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [{ sensorId: "b", value: 1, recordedAt: "2026-01-01T00:00:00Z" }],
      total: 1,
    });
    renderWithQueryClient(<NewSensorNotice />);
    expect(await screen.findByText("新しい機器『ENV-07』から最初のデータが届きました")).toBeTruthy();
  });

  it("別の利用者（ワークスペース）の記録は混ざらない", async () => {
    useAuthStore.setState({ me: { workspaceId: "w2" } as never });
    window.localStorage.setItem("factoreye.seenSensorIds.w1", JSON.stringify(["a"]));
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A")]);
    renderWithQueryClient(<NewSensorNotice />);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem("factoreye.seenSensorIds.w2") ?? "null")).toEqual(["a"]));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("代理閲覧中は出さず、記録もしない", async () => {
    useAuthStore.setState({ impersonation: { accessToken: "t", email: "e", workspaceName: "w", expiresAt: 1 }, me: { workspaceId: "w3" } as never });
    window.localStorage.setItem("factoreye.seenSensorIds.w3", JSON.stringify(["a"]));
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "B")]);
    renderWithQueryClient(<NewSensorNotice />);
    await waitFor(() => expect(api.fetchSensors).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("status")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("factoreye.seenSensorIds.w3") ?? "[]")).toEqual(["a"]);
  });

  it("画面表示モード（キオスク）では出さない", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    useUiStore.setState({ kiosk: true });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "B")]);
    renderWithQueryClient(<NewSensorNotice />);
    await waitFor(() => expect(api.fetchSensors).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("9 件以上は 8 件だけ足し、残りは案内して「見た」にする", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    useUiStore.setState({ selectedDashboardId: "d1" });
    const many = Array.from({ length: 10 }, (_, i) => sensor(`n${i}`, `N${i}`));
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), ...many]);
    vi.mocked(api.addWidget).mockResolvedValue({ id: "w", gridColumn: 1, gridRow: 1, gridWidth: 6, gridHeight: 7 } as never);
    renderWithQueryClient(<NewSensorNotice />);
    expect(await screen.findByText("ほか 2 件は、編集画面のセンサー棚から追加できます")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "ダッシュボードに追加" }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toHaveLength(11));
    expect(api.addWidget).toHaveBeenCalledTimes(8);
  });

  it("途中で失敗したら足せた分は「見た」になり、再試行では残りだけを足す（作ったダッシュボードも再利用）", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "A"), sensor("b", "B"), sensor("c", "C")]);
    vi.mocked(api.fetchDashboards).mockResolvedValue([]);
    vi.mocked(api.createDashboard).mockResolvedValue({ id: "d9" } as never);
    vi.mocked(api.addWidget)
      .mockResolvedValueOnce({ id: "w1", gridColumn: 1, gridRow: 1, gridWidth: 6, gridHeight: 7 } as never)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ id: "w2", gridColumn: 7, gridRow: 1, gridWidth: 6, gridHeight: 7 } as never);
    renderWithQueryClient(<NewSensorNotice />);
    await userEvent.click(await screen.findByRole("button", { name: "ダッシュボードに追加" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["a", "b"]);
    await userEvent.click(screen.getByRole("button", { name: "ダッシュボードに追加" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(api.createDashboard).toHaveBeenCalledTimes(1);
    const sensorIds = vi.mocked(api.addWidget).mock.calls.map((c) => c[1].sensorId);
    expect(sensorIds).toEqual(["b", "c", "c"]);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["a", "b", "c"]);
  });

  it("追加中に着いたセンサーの通知は消えない。二重に押しても足すのは 1 回分", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["a"]));
    useUiStore.setState({ selectedDashboardId: "d1" });
    let list = [sensor("a", "A"), sensor("b", "B")];
    vi.mocked(api.fetchSensors).mockImplementation(async () => list);
    let release: () => void = () => {};
    vi.mocked(api.addWidget).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ id: "w", gridColumn: 1, gridRow: 1, gridWidth: 6, gridHeight: 7 } as never); }),
    );
    const { rerender } = renderWithQueryClient(<NewSensorNotice />);
    const button = await screen.findByRole("button", { name: "ダッシュボードに追加" });
    await userEvent.dblClick(button);
    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));
    list = [...list, sensor("c", "C")];
    // 5 秒ごとの取り直しを待たず、画面の取り直しを起こす
    rerender(<NewSensorNotice />);
    release();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["a", "b"]));
    expect(api.addWidget).toHaveBeenCalledTimes(1);
  });
});
