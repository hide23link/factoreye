import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import type { DashboardDetail, Widget } from "../types";
import { WidgetCard } from "./WidgetCard";

vi.mock("../lib/api", () => ({
  deleteWidget: vi.fn(),
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchAlarms: vi.fn(),
  addWidget: vi.fn(),
  updateWidget: vi.fn(),
  fetchSensorReadingsAggregate: vi.fn(),
}));

import * as api from "../lib/api";

const dashboard: DashboardDetail = {
  id: "d1",
  name: "テストダッシュボード",
  description: null,
  layoutConfig: {},
  widgets: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: null,
    type: "AlarmAlert",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 4,
    gridHeight: 4,
    config: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WidgetCard", () => {
  it("ドラッグハンドルと編集・削除ボタンを表示する", async () => {
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);

    expect(screen.getByLabelText("ドラッグして移動")).toBeInTheDocument();
    expect(screen.getByLabelText("ウィジェットを編集")).toBeInTheDocument();
    expect(screen.getByLabelText("ウィジェットを削除")).toBeInTheDocument();
  });

  it("削除ボタンを押すとdeleteWidgetを呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.deleteWidget).mockResolvedValue(undefined);

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);

    await user.click(screen.getByLabelText("ウィジェットを削除"));

    await waitFor(() => expect(api.deleteWidget).toHaveBeenCalledWith("w1"));
  });

  it("不明なウィジェットタイプのとき未対応メッセージを表示する", () => {
    renderWithQueryClient(
      <WidgetCard
        widget={makeWidget({ type: "UnknownType" as Widget["type"] })}
        dashboard={dashboard}
      />,
    );

    expect(screen.getByText(/未対応のウィジェットタイプ/)).toBeInTheDocument();
  });

  it("AlarmAlertウィジェットをレンダリングする", async () => {
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<WidgetCard widget={makeWidget({ type: "AlarmAlert" })} dashboard={dashboard} />);

    expect(await screen.findByText("現在アラームはありません")).toBeInTheDocument();
  });
});
