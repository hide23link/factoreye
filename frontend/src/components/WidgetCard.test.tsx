import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import type { DashboardDetail, Widget } from "../types";
import { useEditorStore } from "../store/useEditorStore";
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

beforeEach(() => useEditorStore.getState().reset());

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WidgetCard", () => {
  it("閲覧中は、移動・複製・削除の操作を出さない", async () => {
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);

    expect(await screen.findByText("現在アラームはありません")).toBeInTheDocument();
    expect(screen.queryByLabelText("ドラッグして移動")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("ウィジェットを削除")).not.toBeInTheDocument();
  });

  it("編集中は、移動の見出しと複製・削除を出す", async () => {
    useEditorStore.getState().startEditing();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);

    expect(screen.getByLabelText("ドラッグして移動")).toBeInTheDocument();
    expect(screen.getByLabelText("ウィジェットを複製")).toBeInTheDocument();
    expect(screen.getByLabelText("ウィジェットを削除")).toBeInTheDocument();
  });

  it("編集中にクリックすると選択され、Enter でも選択できる", async () => {
    const user = userEvent.setup();
    useEditorStore.getState().startEditing();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);

    const card = screen.getByRole("group", { name: "アラーム一覧" });
    await user.click(card);
    expect(useEditorStore.getState().selectedWidgetId).toBe("w1");

    useEditorStore.getState().select(null);
    card.focus();
    await user.keyboard("{Enter}");
    expect(useEditorStore.getState().selectedWidgetId).toBe("w1");
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
      readings: [{ sensorId: "s1", value: 5, recordedAt: "2024-01-01T00:00:00.000Z" }],
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
    expect(screen.getByRole("group", { name: "数値" })).toBeInTheDocument();
    expect(await screen.findByText("冷蔵庫温度")).toBeInTheDocument();
  });

  it("編集中に削除ボタンを押すと、確認なしで deleteWidget を呼び、「元に戻す」つきの通知を出す", async () => {
    const user = userEvent.setup();
    useEditorStore.getState().startEditing();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.deleteWidget).mockResolvedValue(undefined);

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={{ ...dashboard, widgets: [makeWidget()] }} />);

    await user.click(screen.getByLabelText("ウィジェットを削除"));

    await waitFor(() => expect(api.deleteWidget).toHaveBeenCalledWith("w1"));
    await waitFor(() => expect(useEditorStore.getState().toast?.action?.label).toBe("元に戻す"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("削除に失敗したとき、理由を通知に出し、履歴に残さない", async () => {
    const user = userEvent.setup();
    useEditorStore.getState().startEditing();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.deleteWidget).mockRejectedValue(new Error("network"));

    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={{ ...dashboard, widgets: [makeWidget()] }} />);

    await user.click(screen.getByLabelText("ウィジェットを削除"));

    await waitFor(() => expect(useEditorStore.getState().toast?.message).toMatch(/ウィジェットの削除に失敗しました/));
    expect(useEditorStore.getState().history).toHaveLength(0);
  });

  it("複製すると、同じ設定で下に新しいウィジェットを作る", async () => {
    const user = userEvent.setup();
    useEditorStore.getState().startEditing();
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.addWidget).mockResolvedValue(makeWidget({ id: "w2" }));
    const widget = makeWidget({ gridWidth: 4, gridHeight: 4, config: { foo: 1 } as Widget["config"] });

    renderWithQueryClient(<WidgetCard widget={widget} dashboard={{ ...dashboard, widgets: [widget] }} />);

    await user.click(screen.getByLabelText("ウィジェットを複製"));

    await waitFor(() =>
      expect(api.addWidget).toHaveBeenCalledWith(
        "d1",
        expect.objectContaining({ type: "AlarmAlert", gridColumn: 1, gridRow: 5, config: { foo: 1 } }),
      ),
    );
    await waitFor(() => expect(useEditorStore.getState().selectedWidgetId).toBe("w2"));
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
