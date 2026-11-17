import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
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
