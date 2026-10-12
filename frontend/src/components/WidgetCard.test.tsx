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

  it("遅延読み込みのウィジェット（StatValue）は、読み込み中の表示のあと、中身を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([
      {
        id: "s1",
        name: "冷蔵庫温度",
        ingestKey: "fridge-temp",
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
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [{ id: 1, sensorId: "s1", value: 5, recordedAt: "2024-01-01T00:00:00.000Z" }],
      total: 1,
    });

    renderWithQueryClient(
      <WidgetCard
        widget={makeWidget({
          type: "StatValue",
          sensorId: "s1",
          config: { timeRangeHours: 1, decimals: 1 },
        })}
        dashboard={dashboard}
      />,
    );

    // 枠は先に出て、中身は読み込み後に出る
    expect(screen.getByLabelText("ウィジェットを編集")).toBeInTheDocument();
    expect(await screen.findByText("冷蔵庫温度")).toBeInTheDocument();
  });

  it("削除ボタンを押すとdeleteWidgetを呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.deleteWidget).mockResolvedValue(undefined);

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);

    await user.click(screen.getByLabelText("ウィジェットを削除"));
    // 確認の小窓が出るまでは、削除しない
    expect(api.deleteWidget).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "削除" }));

    await waitFor(() => expect(api.deleteWidget).toHaveBeenCalledWith("w1"));
  });

  it("削除の確認でキャンセルすると、deleteWidgetを呼ばない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);

    await user.click(screen.getByLabelText("ウィジェットを削除"));
    await user.click(await screen.findByRole("button", { name: "キャンセル" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.deleteWidget).not.toHaveBeenCalled();
  });

  it("削除に失敗したとき、エラーを表示する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.deleteWidget).mockRejectedValue(new Error("network"));

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);

    await user.click(screen.getByLabelText("ウィジェットを削除"));
    await user.click(await screen.findByRole("button", { name: "削除" }));

    expect(await screen.findByText(/ウィジェットの削除に失敗しました/)).toBeInTheDocument();
  });

  it("削除の通信中は、削除ボタンを押せない（二重に削除しない）", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.deleteWidget).mockReturnValue(new Promise(() => {}));

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);

    await user.click(screen.getByLabelText("ウィジェットを削除"));
    await user.click(await screen.findByRole("button", { name: "削除" }));

    await waitFor(() => expect(screen.getByLabelText("ウィジェットを削除")).toBeDisabled());
    await user.click(screen.getByLabelText("ウィジェットを削除"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.deleteWidget).toHaveBeenCalledTimes(1);
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
