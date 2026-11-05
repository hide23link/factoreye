import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { DEFAULT_RANGE } from "../../lib/timeRange";
import { SensorGraphWidget } from "./SensorGraphWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

vi.mock("../../hooks/useNow", () => ({
  useNow: () => new Date("2024-01-01T01:00:00.000Z").getTime(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "ライン温度",
  ingestKey: "line-temp",
  unit: "°C",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: null,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: "s1",
    type: "SensorGraph",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 6,
    config: { timeRangeHours: 1, graphType: "line" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
});

describe("SensorGraphWidget", () => {
  it("sensorIdがnullのときメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 1,
      buckets: [],
    });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget({ sensorId: null })} />);

    expect(screen.getByText("センサーが設定されていません")).toBeInTheDocument();
  });

  it("ローディング中はローディングメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.fetchSensorReadingsDownsampled).mockReturnValue(new Promise(() => {}));

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget()} />);

    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
  });

  it("データ取得後にセンサー名を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [
        { start: "2024-01-01T00:00:00.000Z", min: 25, avg: 25.5, max: 26, count: 2 },
      ],
    });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget()} />);

    expect(await screen.findByText(/ライン温度/)).toBeInTheDocument();
  });

  it("表示範囲は、ダッシュボードの範囲（時間範囲の状態）に従って取得する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [],
    });
    // 固定期間（2024-01-01 00:00〜00:30 UTC）に切り替えておく
    useTimeRangeStore.setState({
      range: {
        mode: "absolute",
        from: Date.parse("2024-01-01T00:00:00.000Z"),
        to: Date.parse("2024-01-01T00:30:00.000Z"),
      },
    });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget()} />);

    await screen.findByText(/ライン温度/);
    expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalledWith(
      "s1",
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:30:00.000Z",
      500,
    );
  });
  it("ウィジェット固有の期間（rangeHours）があれば、ダッシュボード全体の範囲より優先する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });
    // ダッシュボード全体は固定期間でも、このウィジェットは「直近 6 時間」（現在は 01:00 に固定）
    useTimeRangeStore.setState({
      range: { mode: "absolute", from: Date.parse("2023-12-01T00:00:00.000Z"), to: Date.parse("2023-12-01T00:30:00.000Z") },
    });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget({ config: { rangeHours: 6 } })} />);

    await screen.findByText(/ライン温度/);
    expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalledWith(
      "s1",
      "2023-12-31T19:00:00.000Z",
      "2024-01-01T01:00:00.000Z",
      500,
    );
  });

  it("センサーが2つ以上なら、複数の線を重ねて描く（センサーごとに取得する）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor, { ...sensor, id: "s2", name: "炉内圧" }]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });

    renderWithQueryClient(
      <SensorGraphWidget widget={makeWidget({ config: { sensorIds: ["s1", "s2"], graphType: "area" } })} />,
    );

    expect(screen.queryByText("複数センサー比較")).toBeNull();
    const requested = vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.map((c) => c[0]);
    expect(requested).toEqual(expect.arrayContaining(["s1", "s2"]));
  });

  it("しきい値の線を表示する設定でも、描画で壊れない", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([{ ...sensor, thresholdMaxWarning: 30, thresholdMaxCritical: 40 }]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [{ start: "2024-01-01T00:00:00.000Z", min: 25, avg: 25.5, max: 26, count: 2 }],
    });

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget({ config: { showThresholds: true } })} />);

    expect(await screen.findByText(/ライン温度/)).toBeInTheDocument();
  });
  // jsdom ではグラフの中身（線や帯）は描かれないので、新しい見た目の設定で壊れないことだけを確かめる
  it.each(["line", "area", "bar"] as const)("見た目の設定（%s）をすべて指定しても、描画で壊れない", async (graphType) => {
    vi.mocked(api.fetchSensors).mockResolvedValue([{ ...sensor, thresholdMaxWarning: 30, thresholdMaxCritical: 40 }]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [{ start: "2024-01-01T00:00:00.000Z", min: 25, avg: 25.5, max: 26, count: 2 }],
    });
    const config = {
      graphType,
      lineShape: "step",
      lineWidth: 3,
      fillOpacity: 0.5,
      showPoints: true,
      showGrid: false,
      showTooltip: false,
      thresholdMode: "both",
    } as const;

    renderWithQueryClient(<SensorGraphWidget widget={makeWidget({ config })} />);

    expect(await screen.findByText(/ライン温度/)).toBeInTheDocument();
  });

  it.each(["bottom", "right", "off"] as const)("複数センサーで凡例を「%s」にしても、描画で壊れない", async (legendPosition) => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor, { ...sensor, id: "s2", name: "炉内圧" }]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });

    renderWithQueryClient(
      <SensorGraphWidget widget={makeWidget({ config: { sensorIds: ["s1", "s2"], legendPosition, showGrid: false, showTooltip: false } })} />,
    );

    expect(screen.queryByText("複数センサー比較")).toBeNull();
  });
  it("区間の値を最大にすると、最大の値で描く設定でも壊れない（単一センサー）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [{ start: "2024-01-01T00:00:00.000Z", min: 25, avg: 25.5, max: 26, count: 2 }],
    });
    renderWithQueryClient(<SensorGraphWidget widget={makeWidget({ config: { aggregation: "max", refreshSeconds: 10 } })} />);
    expect(await screen.findByText(/ライン温度/)).toBeInTheDocument();
  });

  it.each([
    { graphType: "area", stack: "normal" },
    { graphType: "bar", stack: "percent" },
    { graphType: "line", axisMode: "normalized" },
    { graphType: "area", axisMode: "normalized", aggregation: "min" },
  ] as const)("複数センサーで %o を指定しても、描画で壊れない", async (extra) => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor, { ...sensor, id: "s2", name: "炉内圧" }]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [{ start: "2024-01-01T00:00:00.000Z", min: 25, avg: 25.5, max: 26, count: 2 }],
    });
    renderWithQueryClient(<SensorGraphWidget widget={makeWidget({ config: { sensorIds: ["s1", "s2"], ...extra } })} />);
    expect(screen.queryByText("複数センサー比較")).toBeNull();
  });
});
