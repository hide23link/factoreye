import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import { GRAPH_COLORS } from "../../lib/graph-config";
import { useEditorStore } from "../../store/useEditorStore";
import type { DashboardDetail, Sensor, Widget } from "../../types";
import { WidgetSettings } from "./WidgetSettings";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  updateWidget: vi.fn(),
  addWidget: vi.fn(),
  deleteWidget: vi.fn(),
}));

import * as api from "../../lib/api";

function sensor(id: string, name: string, unit = "℃"): Sensor {
  return {
    id,
    name,
    ingestKey: id,
    unit,
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

function widget(type: Widget["type"], overrides: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: null,
    type,
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 6,
    config: {},
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function dashboardOf(w: Widget): DashboardDetail {
  return { id: "d1", name: "D", description: null, layoutConfig: {}, widgets: [w], createdAt: "", updatedAt: "" };
}

function lastConfig(): Widget["config"] {
  const calls = vi.mocked(api.updateWidget).mock.calls;
  return (calls[calls.length - 1][1] as { config: Widget["config"] }).config;
}

beforeEach(() => {
  useEditorStore.getState().reset();
  vi.mocked(api.fetchSensors).mockResolvedValue([sensor("s1", "温度"), sensor("s2", "圧力", "MPa"), sensor("s3", "ライン1 生産数", "個")]);
  vi.mocked(api.updateWidget).mockImplementation(async (id) => widget("SensorGraph", { id }));
});

afterEach(() => vi.restoreAllMocks());

describe("WidgetSettings: 生産管理", () => {
  const plan = widget("ProductionPlan", { sensorId: "s3", config: { dailyTarget: 1200 } });

  it("計画の説明（稼働時間と1時間あたり）を出す", () => {
    renderWithQueryClient(<WidgetSettings widget={plan} dashboard={dashboardOf(plan)} />);
    expect(screen.getByText("8.0")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
  });

  it("目標の＋で 50 増え、すぐ保存される", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={plan} dashboard={dashboardOf(plan)} />);

    await user.click(screen.getByRole("button", { name: "1日の目標を増やす" }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalled());
    expect(lastConfig()).toMatchObject({ dailyTarget: 1250 });
  });

  it("数値を打ち込んで Enter で確定する。打っている途中では保存しない", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={plan} dashboard={dashboardOf(plan)} />);

    const input = screen.getByRole("spinbutton", { name: "1日の目標" });
    await user.clear(input);
    await user.type(input, "800");
    expect(api.updateWidget).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(lastConfig()).toMatchObject({ dailyTarget: 800 }));
  });

  it("開始を終了以降にすると、終了を開始の1時間後に直す", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={plan} dashboard={dashboardOf(plan)} />);

    const start = screen.getByRole("spinbutton", { name: "勤務開始（時）" });
    await user.clear(start);
    await user.type(start, "18");
    await user.tab();

    await waitFor(() => expect(lastConfig()).toMatchObject({ workStartHour: 18, workEndHour: 19 }));
  });

  it("昼休みと、表示項目の ON/OFF を保存する", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={plan} dashboard={dashboardOf(plan)} />);

    await user.click(screen.getByRole("radio", { name: "45分" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ breakMinutes: 45 }));

    await user.click(screen.getByRole("switch", { name: "時間別の実績グラフ" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ showHourly: false }));
  });

  it("生産数でないセンサーを選んでも設定はでき、注意の通知が出る", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={plan} dashboard={dashboardOf(plan)} />);

    await user.click(screen.getByRole("button", { name: "▼ 一覧から選ぶ" }));
    await user.click(await screen.findByRole("button", { name: /^温度/ }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalledWith("w1", expect.objectContaining({ sensorId: "s1" })));
    expect(useEditorStore.getState().toast?.message).toContain("生産数のセンサーではなさそうです");
  });
});

describe("WidgetSettings: グラフ", () => {
  const graph = widget("SensorGraph", { sensorId: "s1", config: { sensorIds: ["s1", "s2"], colors: ["#111111", "#222222"] } });

  it("色の丸をクリックすると、その線だけ次の色になる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={graph} dashboard={dashboardOf(graph)} />);

    await user.click(await screen.findByRole("button", { name: "圧力の線の色を変える" }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalled());
    expect(lastConfig().colors).toEqual(["#111111", GRAPH_COLORS[0]]);
  });

  it("×でセンサーを外すと、残った線の色が入れ替わらない", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={graph} dashboard={dashboardOf(graph)} />);

    await user.click(await screen.findByRole("button", { name: "温度を外す" }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalledWith("w1", expect.objectContaining({ sensorId: "s2" })));
    expect(lastConfig()).toMatchObject({ sensorIds: ["s2"], colors: ["#222222"] });
  });

  it("センサーが2つのとき、しきい値の線のスイッチは押せない", async () => {
    renderWithQueryClient(<WidgetSettings widget={graph} dashboard={dashboardOf(graph)} />);
    expect(screen.getByRole("switch", { name: "しきい値の線を表示" })).toBeDisabled();
  });

  it("期間は「全体と同じ」に戻せる（rangeHours を消す）", async () => {
    const user = userEvent.setup();
    const w = widget("SensorGraph", { sensorId: "s1", config: { rangeHours: 6 } });
    renderWithQueryClient(<WidgetSettings widget={w} dashboard={dashboardOf(w)} />);

    await user.click(screen.getByRole("radio", { name: "全体と同じ" }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalled());
    expect(lastConfig()).not.toHaveProperty("rangeHours");
  });

  it("縦軸を手動にすると最小・最大の入力欄が出て、自動に戻すと値を消す", async () => {
    const user = userEvent.setup();
    const w = widget("SensorGraph", { sensorId: "s1", config: { yAxisMin: 0, yAxisMax: 100 } });
    renderWithQueryClient(<WidgetSettings widget={w} dashboard={dashboardOf(w)} />);

    expect(screen.getByRole("spinbutton", { name: "縦軸の最小" })).toHaveValue(0);
    await user.click(screen.getByRole("switch", { name: "自動で合わせる" }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalled());
    expect(lastConfig()).not.toHaveProperty("yAxisMin");
    expect(lastConfig()).not.toHaveProperty("yAxisMax");
  });
});

describe("WidgetSettings: アラーム一覧", () => {
  it("設定項目が無いことを案内する", () => {
    const w = widget("AlarmAlert");
    renderWithQueryClient(<WidgetSettings widget={w} dashboard={dashboardOf(w)} />);
    expect(screen.getByText(/設定する項目はありません/)).toBeInTheDocument();
  });
});
