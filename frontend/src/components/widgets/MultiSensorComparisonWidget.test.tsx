import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Widget } from "../../types";
import { MultiSensorComparisonWidget } from "./MultiSensorComparisonWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MultiSensorComparisonWidget", () => {
  it("センサー未設定のときメッセージを表示する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });

    renderWithQueryClient(<MultiSensorComparisonWidget widget={makeWidget()} />);

    expect(screen.getByText("比較対象のセンサーが設定されていません")).toBeInTheDocument();
  });

  it("センサーIDが設定されているとき複数センサー比較ラベルを表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([
      {
        id: "s1",
        name: "温度センサー",
        ingestKey: "temp",
        unit: "°C",
        thresholdMinWarning: null,
        thresholdMinCritical: null,
        thresholdMaxWarning: null,
        thresholdMaxCritical: null,
        thresholdDeadBand: 0,
        enabled: true,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });

    renderWithQueryClient(
      <MultiSensorComparisonWidget widget={makeWidget({ config: { sensorIds: ["s1"], timeRangeHours: 1 } })} />,
    );

    expect(await screen.findByText("複数センサー比較")).toBeInTheDocument();
  });
});
