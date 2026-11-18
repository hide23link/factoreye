import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor } from "../../types";
import { DeviceTreeWidget } from "./DeviceTreeWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchLatestReadings: vi.fn(),
  fetchAlarms: vi.fn(),
}));

import * as api from "../../lib/api";

function sensor(id: string, name: string, extra: Partial<Sensor> = {}): Sensor {
  return {
    id,
    name,
    ingestKey: id,
    unit: "℃",
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

afterEach(() => vi.restoreAllMocks());

describe("DeviceTreeWidget（機器の系統）", () => {
  it("サーバーと、機器ごとの札（最後の受信・止まっている機器の理由）を出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([
      sensor("a", "洋室 温度", { deviceId: "d1", deviceName: "env-youshitsu" }),
      sensor("b", "外気南 温度", { deviceId: "d2", deviceName: "env-south" }),
    ]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({
      readings: [
        { sensorId: "a", value: 20, recordedAt: new Date(Date.now() - 10_000).toISOString() },
        { sensorId: "b", value: 9, recordedAt: new Date(Date.now() - 40 * 60_000).toISOString() },
      ],
      total: 2,
    });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<DeviceTreeWidget />);

    expect(await screen.findByText("env-youshitsu")).toBeInTheDocument();
    expect(screen.getByText("サーバー（FactorEye）")).toBeInTheDocument();
    expect(screen.getByText("env-south")).toBeInTheDocument();
    expect(screen.getByText("受信なし")).toBeInTheDocument();
  });

  it("センサーが無ければ案内する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    renderWithQueryClient(<DeviceTreeWidget />);
    expect(await screen.findByText("センサーがまだありません")).toBeInTheDocument();
  });

  it("読み込み中も、外側の枠（幅を測る要素）を出す", () => {
    vi.mocked(api.fetchSensors).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.fetchLatestReadings).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.fetchAlarms).mockReturnValue(new Promise(() => {}));
    renderWithQueryClient(<DeviceTreeWidget />);
    expect(screen.getByRole("group", { name: "機器の系統図" })).toBeInTheDocument();
    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
  });

  it("機器は 1 列（横）に並べる（段に折り返さない。入りきらないときは横にスクロール）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => sensor(`s${i}`, `センサー${i}`, { deviceId: `d${i}`, deviceName: `env-${i}` })),
    );
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<DeviceTreeWidget />);

    await screen.findByText("env-0");
    // 機器の列は 1 つだけで、その中に 12 台が並ぶ
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(1);
    expect(lists[0].querySelectorAll("li")).toHaveLength(12);
  });
});
