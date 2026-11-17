import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import type { Sensor, Widget } from "../../types";
import { TrendStackWidget } from "./TrendStackWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

import * as api from "../../lib/api";

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

const widget = (ids: string[]): Widget => ({
  id: "w1",
  dashboardId: "d1",
  sensorId: ids[0] ?? null,
  type: "TrendStack",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 12,
  gridHeight: 10,
  config: { sensorIds: ids },
  createdAt: "",
  updatedAt: "",
});

/** 今から minutesAgo 分前を始まりとする 1 分の区間 */
const bucketAgo = (minutesAgo: number, value: number, max = value, min = value) => ({
  start: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  avg: value,
  min,
  max,
  count: 1,
});

beforeEach(() => {
  useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 60 * 60_000 } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TrendStackWidget（計器グラフ）", () => {
  it("センサーが無ければ、入れ方を案内する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    renderWithQueryClient(<TrendStackWidget widget={widget([])} />);
    expect(screen.getByText(/センサーが設定されていません/)).toBeInTheDocument();
  });

  it("最高・最低・平均・今の値・しきい値の数値を出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("co2", "洋室 CO2", { thresholdMaxCritical: 1000 })]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [bucketAgo(30, 600, 640, 580), bucketAgo(20, 900, 980, 880), bucketAgo(2, 1050, 1103, 1040)],
    });

    renderWithQueryClient(<TrendStackWidget widget={widget(["co2"])} />);

    // 左の欄の名前と、グラフの左上（狭い枠のとき用）の名前
    expect((await screen.findAllByText("洋室 CO2")).length).toBeGreaterThan(0);
    // 最高は区間の max（1103）、最低は区間の min（580）
    expect(screen.getByText("1103")).toBeInTheDocument();
    expect(screen.getByText("580")).toBeInTheDocument();
    expect(screen.getByText(/最高 1103/)).toBeInTheDocument();
    // 今の値の札（最後の区間の値）。重故障のしきい値の外
    expect(screen.getByText("1050")).toBeInTheDocument();
    expect(screen.getByText("重 上限 1000")).toBeInTheDocument();
    expect(screen.getByText("上限 1000 ppm")).toBeInTheDocument();
    // 縦軸の目盛り
    expect(screen.getByText("1200")).toBeInTheDocument();
  });

  it("最後の受信が古ければ、今の値は「---」で、受信なしと出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("t", "外気南 温度")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [bucketAgo(50, 8.9), bucketAgo(40, 9.1)],
    });

    renderWithQueryClient(<TrendStackWidget widget={widget(["t"])} />);

    expect(await screen.findByText("---")).toBeInTheDocument();
    expect(screen.getByText(/受信なし/)).toBeInTheDocument();
  });

  it("センサーごとに 1 行ずつ並べる", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA"), sensor("b", "センサーB")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["a", "b"])} />);

    expect((await screen.findAllByText("センサーA")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("センサーB").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("img", { name: /の推移/ })).toHaveLength(2);
  });
});
