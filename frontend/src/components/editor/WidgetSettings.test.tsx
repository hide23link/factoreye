import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, renderWithQueryClient, screen, waitFor, within } from "../../test/test-utils";
import { GRAPH_COLORS } from "../../lib/graph-config";
import { useEditorStore } from "../../store/useEditorStore";
import type { DashboardDetail, Sensor, Widget } from "../../types";
import { SettingsPanel } from "./SettingsPanel";
import { WidgetSettings } from "./WidgetSettings";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  updateWidget: vi.fn(),
  addWidget: vi.fn(),
  deleteWidget: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchSensorReadingsAggregate: vi.fn(),
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
  vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
  vi.mocked(api.fetchSensorReadingsAggregate).mockResolvedValue({ sum: 0, count: 0 });
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

    await user.click(screen.getByRole("button", { name: "＋ センサーを選ぶ" }));
    await user.click(await screen.findByRole("button", { name: /^温度/ }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalledWith("w1", expect.objectContaining({ sensorId: "s1" })));
    expect(useEditorStore.getState().toast?.message).toContain("生産数のセンサーではなさそうです");
  });
});

describe("WidgetSettings: 1つだけ選ぶ欄", () => {
  const stat = widget("StatValue", { sensorId: "s1" });

  it("いま選んでいる行を押しても何も変えずに閉じ、別の行を押すと入れ替わって閉じる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={stat} dashboard={dashboardOf(stat)} />);

    await user.click(await screen.findByRole("button", { name: "＋ センサーを選ぶ" }));
    // 外すボタン（「温度を外す」）と取り違えないよう、選ぶ画面の中から探す
    await user.click(within(await screen.findByRole("group", { name: "センサーを選ぶ" })).getByRole("button", { name: /温度/ }));
    expect(screen.queryByRole("group", { name: "センサーを選ぶ" })).not.toBeInTheDocument();
    expect(api.updateWidget).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "＋ センサーを選ぶ" }));
    await user.click(within(await screen.findByRole("group", { name: "センサーを選ぶ" })).getByRole("button", { name: /^圧力/ }));
    await waitFor(() => expect(api.updateWidget).toHaveBeenCalledWith("w1", expect.objectContaining({ sensorId: "s2" })));
    expect(screen.queryByRole("group", { name: "センサーを選ぶ" })).not.toBeInTheDocument();
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

  it("センサーを追加する画面は、追加してもすぐには閉じず、続けて選べる", async () => {
    const user = userEvent.setup();
    const one = widget("SensorGraph", { sensorId: "s1", config: { sensorIds: ["s1"], colors: ["#111111"] } });
    renderWithQueryClient(<WidgetSettings widget={one} dashboard={dashboardOf(one)} />);

    await user.click(await screen.findByRole("button", { name: "＋ センサーを追加" }));
    await user.click(await screen.findByRole("button", { name: /^圧力/ }));
    await waitFor(() => expect(api.updateWidget).toHaveBeenCalledWith("w1", expect.objectContaining({ sensorId: "s1" })));
    expect(lastConfig()).toMatchObject({ sensorIds: ["s1", "s2"] });
    expect(screen.getByRole("group", { name: "センサーを選ぶ" })).toBeInTheDocument();
  });

  it("センサーを追加する画面で、選択中の行を押すと外れ、残った線の色は保たれる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={graph} dashboard={dashboardOf(graph)} />);

    await user.click(await screen.findByRole("button", { name: "＋ センサーを追加" }));
    const picker = screen.getByRole("group", { name: "センサーを選ぶ" });
    await user.click(within(picker).getByRole("button", { name: /^温度/ }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalled());
    expect(lastConfig()).toMatchObject({ sensorIds: ["s2"], colors: ["#222222"] });
  });

  it("Esc で閉じ、フォーカスは開いたボタンに戻る。ボタンにフォーカスがあるときの Esc でも閉じる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={graph} dashboard={dashboardOf(graph)} />);

    const toggle = await screen.findByRole("button", { name: "＋ センサーを追加" });
    await user.click(toggle);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "センサーを選ぶ" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "＋ センサーを追加" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "＋ センサーを追加" }));
    screen.getByRole("button", { name: "▲ 閉じる" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "センサーを選ぶ" })).not.toBeInTheDocument();
  });

  it("×でセンサーを外すと、残った線の色が入れ替わらない", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={graph} dashboard={dashboardOf(graph)} />);

    await user.click(await screen.findByRole("button", { name: "温度を外す" }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalledWith("w1", expect.objectContaining({ sensorId: "s2" })));
    expect(lastConfig()).toMatchObject({ sensorIds: ["s2"], colors: ["#222222"] });
  });

  it("センサーが2つのとき、しきい値の表示は選べず、案内が出る", () => {
    renderWithQueryClient(<WidgetSettings widget={graph} dashboard={dashboardOf(graph)} />);
    expect(screen.queryByRole("radiogroup", { name: "しきい値の表示" })).not.toBeInTheDocument();
    expect(screen.getByText("センサーを1つにすると使えます")).toBeInTheDocument();
  });

  it("センサーが1つのとき、しきい値の表示を選ぶと thresholdMode に保存し、古い showThresholds を消す", async () => {
    const user = userEvent.setup();
    const one = widget("SensorGraph", { sensorId: "s1", config: { showThresholds: true } });
    renderWithQueryClient(<WidgetSettings widget={one} dashboard={dashboardOf(one)} />);

    // 古い設定（showThresholds: true）は「線」として表示される
    const modes = within(screen.getByRole("radiogroup", { name: "しきい値の表示" }));
    expect(modes.getByRole("radio", { name: "線" })).toHaveAttribute("aria-checked", "true");
    await user.click(modes.getByRole("radio", { name: "両方" }));

    await waitFor(() => expect(api.updateWidget).toHaveBeenCalled());
    expect(lastConfig()).toMatchObject({ thresholdMode: "both" });
    expect(lastConfig().showThresholds).toBeUndefined();
  });

  it("線の形・太さ・点・目盛り・ツールチップを変えると、その項目だけ保存される", async () => {
    const user = userEvent.setup();
    const w = widget("SensorGraph", { sensorId: "s1", config: { graphType: "line" } });
    renderWithQueryClient(<WidgetSettings widget={w} dashboard={dashboardOf(w)} />);

    await user.click(screen.getByRole("radio", { name: "階段" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ lineShape: "step" }));

    await user.click(screen.getByRole("switch", { name: "点を表示" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ showPoints: true }));

    await user.click(screen.getByRole("switch", { name: "目盛りの線" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ showGrid: false }));

    await user.click(screen.getByRole("switch", { name: "ツールチップ（なぞると値が出る）" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ showTooltip: false }));
  });

  it("塗りの濃さは面グラフのときだけ出る。凡例の場所はセンサーが2つ以上のときだけ出る", () => {
    const line = widget("SensorGraph", { sensorId: "s1", config: { graphType: "line" } });
    const { unmount } = renderWithQueryClient(<WidgetSettings widget={line} dashboard={dashboardOf(line)} />);
    expect(screen.queryByLabelText("塗りの濃さ")).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "凡例の場所" })).not.toBeInTheDocument();
    unmount();

    const area = widget("SensorGraph", { sensorId: "s1", config: { graphType: "area", sensorIds: ["s1", "s2"] } });
    renderWithQueryClient(<WidgetSettings widget={area} dashboard={dashboardOf(area)} />);
    expect(screen.getByLabelText("塗りの濃さ")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "凡例の場所" })).toBeInTheDocument();
  });

  it("区間の値と更新間隔を選ぶと、その項目だけ保存される", async () => {
    const user = userEvent.setup();
    const w = widget("SensorGraph", { sensorId: "s1" });
    renderWithQueryClient(<WidgetSettings widget={w} dashboard={dashboardOf(w)} />);

    await user.click(within(screen.getByRole("radiogroup", { name: "区間の値" })).getByRole("radio", { name: "最大" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ aggregation: "max" }));

    await user.click(within(screen.getByRole("radiogroup", { name: "更新間隔" })).getByRole("radio", { name: "1分" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ refreshSeconds: 60 }));
  });

  it("センサーが1つのときは、重ね方（縦軸・積み上げ）を出さない", () => {
    const w = widget("SensorGraph", { sensorId: "s1", config: { graphType: "area" } });
    renderWithQueryClient(<WidgetSettings widget={w} dashboard={dashboardOf(w)} />);
    expect(screen.queryByRole("radiogroup", { name: "縦軸のモード" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "積み上げ" })).not.toBeInTheDocument();
  });

  it("センサーが2つのとき、縦軸を 0〜100% にすると保存し、手動の縦軸と積み上げの欄は隠れる", async () => {
    const user = userEvent.setup();
    const w = widget("SensorGraph", { sensorId: "s1", config: { sensorIds: ["s1", "s2"], graphType: "area" } });
    const { rerender } = renderWithQueryClient(<WidgetSettings widget={w} dashboard={dashboardOf(w)} />);
    expect(screen.getByRole("radiogroup", { name: "積み上げ" })).toBeInTheDocument();
    expect(screen.getByText("自動で合わせる")).toBeInTheDocument();

    await user.click(within(screen.getByRole("radiogroup", { name: "縦軸のモード" })).getByRole("radio", { name: "0〜100%" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ axisMode: "normalized" }));

    const normalized = { ...w, config: { ...w.config, axisMode: "normalized" as const } };
    rerender(<WidgetSettings widget={normalized} dashboard={dashboardOf(normalized)} />);
    expect(screen.queryByRole("radiogroup", { name: "積み上げ" })).not.toBeInTheDocument();
    expect(screen.queryByText("自動で合わせる")).not.toBeInTheDocument();
  });

  it("積み上げは、線グラフでは出ない。面グラフで選ぶと保存される", async () => {
    const user = userEvent.setup();
    const line = widget("SensorGraph", { sensorId: "s1", config: { sensorIds: ["s1", "s2"], graphType: "line" } });
    const { unmount } = renderWithQueryClient(<WidgetSettings widget={line} dashboard={dashboardOf(line)} />);
    expect(screen.queryByRole("radiogroup", { name: "積み上げ" })).not.toBeInTheDocument();
    unmount();

    const bar = widget("SensorGraph", { sensorId: "s1", config: { sensorIds: ["s1", "s2"], graphType: "bar" } });
    renderWithQueryClient(<WidgetSettings widget={bar} dashboard={dashboardOf(bar)} />);
    await user.click(within(screen.getByRole("radiogroup", { name: "積み上げ" })).getByRole("radio", { name: "積み上げ" }));
    await waitFor(() => expect(lastConfig()).toMatchObject({ stack: "normal" }));
  });

  it("期間は「全体」に戻せる（rangeHours を消す）", async () => {
    const user = userEvent.setup();
    const w = widget("SensorGraph", { sensorId: "s1", config: { rangeHours: 6 } });
    renderWithQueryClient(<WidgetSettings widget={w} dashboard={dashboardOf(w)} />);

    await user.click(screen.getByRole("radio", { name: "全体" }));

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

describe("WidgetSettings: ゲージ", () => {
  const gauge = widget("Gauge", { sensorId: "s1" });

  it("目盛りの最小・最大を保存する", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={gauge} dashboard={dashboardOf(gauge)} />);

    const min = screen.getByLabelText("目盛りの最小");
    await user.clear(min);
    await user.type(min, "0{Enter}");
    await waitFor(() => expect(lastConfig()).toMatchObject({ gaugeMin: 0 }));

    const max = screen.getByLabelText("目盛りの最大");
    await user.type(max, "120{Enter}");
    await waitFor(() => expect(lastConfig()).toMatchObject({ gaugeMax: 120 }));
  });

  it("最大を空欄に戻すと、手動の指定が消えて自動に戻る", async () => {
    const user = userEvent.setup();
    const fixed = widget("Gauge", { sensorId: "s1", config: { gaugeMin: 0, gaugeMax: 120 } });
    renderWithQueryClient(<WidgetSettings widget={fixed} dashboard={dashboardOf(fixed)} />);
    await user.clear(screen.getByLabelText("目盛りの最大"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastConfig().gaugeMax).toBeUndefined());
    expect(lastConfig().gaugeMin).toBe(0);
  });

  it("センサーを選び直せる（1つだけ）", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetSettings widget={gauge} dashboard={dashboardOf(gauge)} />);
    await user.click(screen.getByRole("button", { name: "＋ センサーを選ぶ" }));
    await user.click(within(await screen.findByRole("group", { name: "センサーを選ぶ" })).getByRole("button", { name: /^圧力/ }));
    await waitFor(() => expect(api.updateWidget).toHaveBeenCalledWith("w1", expect.objectContaining({ sensorId: "s2" })));
  });
});

describe("WidgetSettings: アラーム一覧", () => {
  it("設定項目が無いことを案内する", () => {
    const w = widget("AlarmAlert");
    renderWithQueryClient(<WidgetSettings widget={w} dashboard={dashboardOf(w)} />);
    expect(screen.getByText(/設定する項目はありません/)).toBeInTheDocument();
  });
});

describe("SettingsPanel: ウィジェットの切り替え", () => {
  it("縦軸を手動にしたあと別のウィジェットを選んでも、前の状態を引き継がない", async () => {
    const user = userEvent.setup();
    const a = widget("SensorGraph", { id: "a", sensorId: "s1" });
    const b = widget("SensorGraph", { id: "b", sensorId: "s2" });
    const dashboard: DashboardDetail = { ...dashboardOf(a), widgets: [a, b] };
    useEditorStore.getState().select("a");
    renderWithQueryClient(<SettingsPanel dashboard={dashboard} />);

    await user.click(screen.getByRole("switch", { name: "自動で合わせる" }));
    expect(screen.getByRole("spinbutton", { name: "縦軸の最小" })).toBeInTheDocument();

    act(() => useEditorStore.getState().select("b"));

    expect(screen.queryByRole("spinbutton", { name: "縦軸の最小" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "自動で合わせる" })).toBeChecked();
  });
});
