import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { FloorPlanWidget } from "./FloorPlanWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchLatestReadings: vi.fn(),
  fetchAlarms: vi.fn(),
  updateWidget: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "a",
  name: "洋室 CO2",
  ingestKey: "a",
  unit: "ppm",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: 1000,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "",
  updatedAt: "",
  deviceId: "d1",
  deviceName: "env-youshitsu",
};

const widget = (config: Widget["config"]): Widget => ({
  id: "w1",
  dashboardId: "dash",
  sensorId: null,
  type: "FloorPlan",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 8,
  gridHeight: 9,
  config,
  createdAt: "",
  updatedAt: "",
});

function mockData() {
  vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
  vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [{ sensorId: "a", value: 1050, recordedAt: new Date().toISOString() }], total: 1 });
  vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
}

afterEach(() => vi.restoreAllMocks());

describe("FloorPlanWidget（配置図）", () => {
  it("保存してある部屋の枠と、置いた機器の札（状態つき）を出す", async () => {
    mockData();
    renderWithQueryClient(
      <FloorPlanWidget
        widget={widget({
          floorRooms: [{ id: "r1", name: "洋室", x: 10, y: 10, w: 40, h: 40 }],
          floorPlacements: { "device:d1": { x: 20, y: 20 } },
        })}
      />,
    );

    expect(await screen.findByText("env-youshitsu")).toBeInTheDocument();
    expect(screen.getByText("洋室")).toBeInTheDocument();
    expect(screen.getByText("洋室 CO2 重故障")).toBeInTheDocument();
  });

  it("札に、1 時間前からの変化を出す。表示の種類を選ぶと、その種類の値にする（選んだ種類は覚える）", async () => {
    window.localStorage.clear();
    const temperature: Sensor = { ...sensor, id: "t", name: "洋室 温度", unit: "℃", thresholdMaxCritical: null };
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor, temperature]);
    // before 付きの取得は「1 時間前の値」。付かない取得は「今の値」
    vi.mocked(api.fetchLatestReadings).mockImplementation((before?: string) => {
      const at = new Date().toISOString();
      return Promise.resolve(
        before === undefined
          ? { readings: [{ sensorId: "a", value: 650, recordedAt: at }, { sensorId: "t", value: 22.4, recordedAt: at }], total: 2 }
          : { readings: [{ sensorId: "a", value: 640, recordedAt: at }, { sensorId: "t", value: 21.8, recordedAt: at }], total: 2 },
      );
    });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<FloorPlanWidget widget={widget({ floorPlacements: { "device:d1": { x: 20, y: 40 } } })} />);

    // 「すべて」: 先頭の値と、その 1 時間の変化
    expect(await screen.findByText(/650ppm 22\.4℃/)).toBeInTheDocument();
    expect(await screen.findByText(/↑10/)).toBeInTheDocument();
    // 温度を選ぶと、温度の値と変化
    await userEvent.click(screen.getByRole("button", { name: "温度" }));
    expect(await screen.findByText("22.4℃")).toBeInTheDocument();
    expect(screen.getByText(/↑0\.6/)).toBeInTheDocument();
    expect(window.localStorage.getItem("fe-floorplan-kind")).toBe("温度");
  });

  it("1 時間前の値が、止まっていた古い値（15 分より前）なら、変化は出さない（0.0 とも出さない）", async () => {
    window.localStorage.clear();
    vi.mocked(api.fetchSensors).mockResolvedValue([{ ...sensor, thresholdMaxCritical: null }]);
    vi.mocked(api.fetchLatestReadings).mockImplementation((before?: string) =>
      Promise.resolve({
        readings: [
          {
            sensorId: "a",
            value: 650,
            // 今の値は新しい。1 時間前の値は、1 時間前の 40 分前の測定（その時点でもう止まっていた）
            recordedAt: new Date(before === undefined ? Date.now() : Date.now() - 100 * 60_000).toISOString(),
          },
        ],
        total: 1,
      }),
    );
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<FloorPlanWidget widget={widget({ floorPlacements: { "device:d1": { x: 20, y: 40 } } })} />);

    expect(await screen.findByText("650ppm")).toBeInTheDocument();
    await waitFor(() => expect(api.fetchLatestReadings).toHaveBeenCalledWith(expect.any(String)));
    expect(screen.queryByText(/↑|↓|0\.0/)).not.toBeInTheDocument();
  });

  it("受信が止まった機器の札は「受信なし 5m」。点から札へ引き出し線が出る", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [{ sensorId: "a", value: 600, recordedAt: new Date(Date.now() - 20 * 60_000).toISOString() }], total: 1 });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<FloorPlanWidget widget={widget({ floorPlacements: { "device:d1": { x: 20, y: 40 } } })} />);

    expect(await screen.findByText(/受信なし 20m/)).toBeInTheDocument();
  });

  it("設定が空なら、編集で置けることを案内する", async () => {
    mockData();
    renderWithQueryClient(<FloorPlanWidget widget={widget({})} />);
    expect(await screen.findByText(/「配置を編集」で/)).toBeInTheDocument();
  });

  it("配置を編集 → 機器を置く → 保存すると、ウィジェットの設定に書く", async () => {
    mockData();
    vi.mocked(api.updateWidget).mockResolvedValue(widget({}));
    const user = userEvent.setup();
    renderWithQueryClient(<FloorPlanWidget widget={widget({})} />);

    await user.click(await screen.findByRole("button", { name: "配置を編集" }));
    await user.click(screen.getByRole("button", { name: /\+ env-youshitsu/ }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(api.updateWidget).toHaveBeenCalledTimes(1);
    const [id, body] = vi.mocked(api.updateWidget).mock.calls[0];
    expect(id).toBe("w1");
    expect(body.config?.floorPlacements).toHaveProperty(["device:d1"]);
  });
});
