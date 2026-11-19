import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor, within } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { DEFAULT_RANGE } from "../../lib/timeRange";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { MultiSensorComparisonWidget } from "./MultiSensorComparisonWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

vi.mock("../../hooks/useNow", () => ({
  useNow: () => new Date("2024-01-01T01:00:00.000Z").getTime(),
}));

import * as api from "../../lib/api";

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: null,
    type: "MultiSensorComparison",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 6,
    config: { timeRangeHours: 1 },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSensor(id: string, name: string): Sensor {
  return {
    id,
    name,
    ingestKey: id,
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
}

afterEach(() => {
  vi.restoreAllMocks();
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
});

describe("MultiSensorComparisonWidget", () => {
  it("センサー未設定のときメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<MultiSensorComparisonWidget widget={makeWidget()} />);

    expect(screen.getByText("比較対象のセンサーが設定されていません")).toBeInTheDocument();
  });

  it("センサーIDが設定されているとき、複数センサー比較の見出しは出さない", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("s1", "温度センサー")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [],
    });

    renderWithQueryClient(
      <MultiSensorComparisonWidget
        widget={makeWidget({ config: { sensorIds: ["s1"], timeRangeHours: 1 } })}
      />,
    );

    expect(screen.queryByText("複数センサー比較")).toBeNull();
  });

  it("全センサーを、同じ範囲・同じ区間数で取得する（時間軸を揃えるため）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([
      makeSensor("s1", "温度センサー"),
      makeSensor("s2", "湿度センサー"),
    ]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [],
    });
    useTimeRangeStore.setState({
      range: {
        mode: "absolute",
        from: Date.parse("2024-01-01T00:00:00.000Z"),
        to: Date.parse("2024-01-01T00:30:00.000Z"),
      },
    });

    renderWithQueryClient(
      <MultiSensorComparisonWidget
        widget={makeWidget({ config: { sensorIds: ["s1", "s2"], timeRangeHours: 1 } })}
      />,
    );

    await waitFor(() => expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalledTimes(2));
    for (const sensorId of ["s1", "s2"]) {
      expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalledWith(
        sensorId,
        "2024-01-01T00:00:00.000Z",
        "2024-01-01T00:30:00.000Z",
        500,
      );
    }
  });

  it("複数のときの最高・最低・平均（札の title）は、センサーごとの区間の max・min と、avg を件数で重みづけした平均", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("s1", "洋室"), makeSensor("s2", "寝室")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (sensorId) => ({
      bucketSeconds: 60,
      buckets:
        sensorId === "s1"
          ? [
              { start: "2024-01-01T00:10:00.000Z", min: 10, max: 30, avg: 20, count: 3 },
              { start: "2024-01-01T00:20:00.000Z", min: 0, max: 40, avg: 30, count: 1 },
            ]
          : [{ start: "2024-01-01T00:10:00.000Z", min: 5, max: 6, avg: 5, count: 1 }],
    }));

    renderWithQueryClient(
      <MultiSensorComparisonWidget widget={makeWidget({ config: { sensorIds: ["s1", "s2"], timeRangeHours: 1, decimals: 1 } as Widget["config"] })} />,
    );

    // 洋室: 最高 40.0（区間 max の最大）、最低 0.0（区間 min の最小）、平均 22.5（(20×3 + 30×1) ÷ 4）
    await waitFor(() => expect(screen.getByTitle("洋室 最高 40.0 最低 0.0 平均 22.5")).toBeInTheDocument());
  });

  it("凡例の表の最小・最大・平均は線と同じ区間データから出し、行を押すとその 1 本だけが選ばれる", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("s1", "洋室"), makeSensor("s2", "寝室")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (sensorId) => ({
      bucketSeconds: 60,
      buckets:
        sensorId === "s1"
          ? [
              { start: "2024-01-01T00:10:00.000Z", min: 10, max: 30, avg: 20, count: 3 },
              { start: "2024-01-01T00:20:00.000Z", min: 0, max: 40, avg: 30, count: 1 },
            ]
          : [{ start: "2024-01-01T00:10:00.000Z", min: 5, max: 6, avg: 5, count: 1 }],
    }));

    renderWithQueryClient(
      <MultiSensorComparisonWidget widget={makeWidget({ config: { sensorIds: ["s1", "s2"], timeRangeHours: 1, decimals: 1 } as Widget["config"] })} />,
    );

    const row = (await screen.findByRole("button", { name: "洋室 だけ表示する" })).closest("tr") as HTMLElement;
    // 最小 0.0・最大 40.0・平均 22.5（件数で重みづけ）
    await waitFor(() => expect(within(row).getByText("22.5")).toBeInTheDocument());
    expect(within(row).getByText("40.0")).toBeInTheDocument();
    expect(within(row).getByText("0.0")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(row).getByRole("button"));
    expect(screen.getByRole("button", { name: "洋室 だけ表示する" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "寝室 だけ表示する" })).toHaveAttribute("aria-pressed", "false");
    await user.click(within(row).getByRole("button"));
    expect(screen.getByRole("button", { name: "洋室 だけ表示する" })).toHaveAttribute("aria-pressed", "false");
  });

  it("0〜100% にそろえて最新値が未取得でも、凡例の表の「値（最新）」は換算前の値を出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("s1", "洋室"), makeSensor("s2", "寝室")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (sensorId) => ({
      bucketSeconds: 60,
      buckets: [
        { start: "2024-01-01T00:10:00.000Z", min: 10, max: 10, avg: 10, count: 1 },
        { start: "2024-01-01T00:20:00.000Z", min: 20, max: 20, avg: sensorId === "s1" ? 20 : 30, count: 1 },
      ],
    }));
    renderWithQueryClient(
      <MultiSensorComparisonWidget
        widget={makeWidget({ config: { sensorIds: ["s1", "s2"], timeRangeHours: 1, decimals: 1, axisMode: "normalized" } as Widget["config"] })}
      />,
    );
    const row = (await screen.findByRole("button", { name: "洋室 だけ表示する" })).closest("tr") as HTMLElement;
    // 洋室の最新は 20.0（換算後の 100 ではない）
    await waitFor(() => expect(within(row).getAllByText("20.0").length).toBeGreaterThan(0));
    expect(within(row).queryByText("100.0")).toBeNull();
  });

  it("積み上げでは、実測のない区間の埋めた値を、値の列に出さない（最新は実測の最後の値）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("s1", "洋室"), makeSensor("s2", "寝室")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (sensorId) => ({
      bucketSeconds: 60,
      buckets:
        sensorId === "s1"
          ? [{ start: "2024-01-01T00:10:00.000Z", min: 7, max: 7, avg: 7, count: 1 }]
          : [
              { start: "2024-01-01T00:10:00.000Z", min: 1, max: 1, avg: 1, count: 1 },
              { start: "2024-01-01T00:20:00.000Z", min: 2, max: 2, avg: 2, count: 1 },
            ],
    }));
    renderWithQueryClient(
      <MultiSensorComparisonWidget
        widget={makeWidget({ config: { sensorIds: ["s1", "s2"], timeRangeHours: 1, decimals: 1, graphType: "area", stack: "normal" } as Widget["config"] })}
      />,
    );
    const row = (await screen.findByRole("button", { name: "洋室 だけ表示する" })).closest("tr") as HTMLElement;
    // 洋室の最後の実測は 7.0。20 分の行に埋めた 0.0 は出さない（値・最小・最大・平均がすべて 7.0 で 4 回）
    await waitFor(() => expect(within(row).getAllByText("7.0").length).toBe(4));
  });

  it("凡例の表は、未設定・入のとき出る。切のときは出さず、元の凡例を出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("s1", "洋室"), makeSensor("s2", "寝室")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [{ start: "2024-01-01T00:10:00.000Z", min: 1, max: 1, avg: 1, count: 1 }],
    });
    const config = (extra: object) => ({ sensorIds: ["s1", "s2"], timeRangeHours: 1, ...extra }) as Widget["config"];

    const unset = renderWithQueryClient(<MultiSensorComparisonWidget widget={makeWidget({ config: config({}) })} />);
    expect(await screen.findByTestId("legend-table")).toBeInTheDocument();
    unset.unmount();

    const on = renderWithQueryClient(<MultiSensorComparisonWidget widget={makeWidget({ config: config({ showLegendTable: true }) })} />);
    expect(await screen.findByTestId("legend-table")).toBeInTheDocument();
    on.unmount();

    renderWithQueryClient(<MultiSensorComparisonWidget widget={makeWidget({ config: config({ showLegendTable: false }) })} />);
    await waitFor(() => expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalled());
    expect(screen.queryByTestId("legend-table")).toBeNull();
  });
});
