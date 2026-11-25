/**
 * ふつうのグラフ・複数のグラフで、データが無い区間（受信が止まった間）の線を切るかの試験。
 * jsdom では ResponsiveContainer の大きさが 0 で線が描かれないため、ここだけ決まった大きさ（600×300）で描く。
 */
import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { DEFAULT_RANGE } from "../../lib/timeRange";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { SensorGraphWidget } from "./SensorGraphWidget";

vi.mock("recharts", async (importOriginal) => {
  const original = await importOriginal<typeof import("recharts")>();
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 300 }),
  };
});

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  fetchLatestReadings: vi.fn(),
}));

const NOW = new Date("2024-01-01T01:00:00.000Z").getTime();
vi.mock("../../hooks/useNow", () => ({
  useNow: () => new Date("2024-01-01T01:00:00.000Z").getTime(),
}));

import * as api from "../../lib/api";

function sensor(id: string): Sensor {
  return {
    id,
    name: `センサー${id}`,
    ingestKey: id,
    unit: "°C",
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: null,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "",
    updatedAt: "",
  };
}

function widget(ids: string[], config: Widget["config"] = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: ids[0],
    type: "SensorGraph",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 6,
    config: { sensorIds: ids, graphType: "line", ...config },
    createdAt: "",
    updatedAt: "",
  };
}

/** 1 時間前から 1 分ごとの区間。止まっていた分（skip に入れた分）は区間が無い */
function minuteBuckets(skip: (minute: number) => boolean) {
  return {
    bucketSeconds: 60,
    buckets: Array.from({ length: 60 }, (_, minute) => minute)
      .filter((minute) => !skip(minute))
      .map((minute) => ({ start: new Date(NOW - (60 - minute) * 60_000).toISOString(), avg: 20 + (minute % 5), min: 19, max: 25, count: 5 })),
  };
}

/** 線の道筋（d）の「M」（線の描き始め）の数 ＝ 線のかたまりの数 */
async function lineSegments(): Promise<number[]> {
  await screen.findAllByText(/センサー/);
  const curves = await vi.waitFor(() => {
    const found = Array.from(document.querySelectorAll(".recharts-line-curve"));
    if (found.length === 0) throw new Error("線がまだ描かれていない");
    return found;
  });
  return curves.map((curve) => (curve.getAttribute("d") ?? "").split("M").length - 1);
}

afterEach(() => {
  vi.restoreAllMocks();
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
});

describe("データが無い区間の線（ふつうのグラフ・複数のグラフ）", () => {
  it("ふつうのグラフ: 20〜39 分が止まっていたら、線は 2 つに切れる（直線でつながない）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a")]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue(minuteBuckets((m) => m >= 20 && m < 40));

    renderWithQueryClient(<SensorGraphWidget widget={widget(["a"])} />);

    expect(await lineSegments()).toEqual([2]);
  });

  it("ふつうのグラフ: 止まっていなければ、線は 1 つのまま", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a")]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue(minuteBuckets(() => false));

    renderWithQueryClient(<SensorGraphWidget widget={widget(["a"])} />);

    expect(await lineSegments()).toEqual([1]);
  });

  it("複数のグラフ: 止まっていたセンサーの線だけ切れる。もう片方は 1 つのまま", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a"), sensor("b")]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (id) =>
      id === "a" ? minuteBuckets((m) => m >= 20 && m < 40) : minuteBuckets(() => false),
    );

    renderWithQueryClient(<SensorGraphWidget widget={widget(["a", "b"])} />);

    expect(await lineSegments()).toEqual([2, 1]);
  });

  it("複数のグラフ: 送る間隔が区間より長い機器（3 分ごと）でも、止まっていなければ線は切れない", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a"), sensor("b")]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (id) =>
      id === "a" ? minuteBuckets((m) => m % 3 !== 0) : minuteBuckets(() => false),
    );

    renderWithQueryClient(<SensorGraphWidget widget={widget(["a", "b"])} />);

    expect(await lineSegments()).toEqual([1, 1]);
  });

  it("積み上げのときは、今までどおり（欠けは埋めて、線を切らない）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a"), sensor("b")]);
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (id) =>
      id === "a" ? minuteBuckets((m) => m >= 20 && m < 40) : minuteBuckets(() => false),
    );

    renderWithQueryClient(<SensorGraphWidget widget={widget(["a", "b"], { graphType: "area", stack: "normal" })} />);

    await screen.findAllByText(/センサー/);
    const curves = await vi.waitFor(() => {
      const found = Array.from(document.querySelectorAll(".recharts-area-curve"));
      if (found.length === 0) throw new Error("面がまだ描かれていない");
      return found;
    });
    expect(curves.map((curve) => (curve.getAttribute("d") ?? "").split("M").length - 1)).toEqual([1, 1]);
  });
});
