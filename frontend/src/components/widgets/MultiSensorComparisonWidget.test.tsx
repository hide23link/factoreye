import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
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

  it("センサーIDが設定されているとき複数センサー比較ラベルを表示する", async () => {
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

    expect(await screen.findByText("複数センサー比較")).toBeInTheDocument();
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
});
