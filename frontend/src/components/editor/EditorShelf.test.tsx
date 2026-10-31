import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor, within } from "../../test/test-utils";
import { useEditorStore } from "../../store/useEditorStore";
import type { DashboardDetail, Sensor, Widget } from "../../types";
import { EditorShelf } from "./EditorShelf";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchSensorReadingsAggregate: vi.fn(),
  fetchAlarms: vi.fn(),
  addWidget: vi.fn(),
  updateWidget: vi.fn(),
  deleteWidget: vi.fn(),
  fetchDashboard: vi.fn(),
}));

import * as api from "../../lib/api";

const dashboard: DashboardDetail = {
  id: "d1",
  name: "工場A",
  description: "",
  layoutConfig: {},
  widgets: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function makeSensor(id: string, name: string, device?: string, line?: string, unit = "V"): Sensor {
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
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    deviceId: device ? `dev-${device}` : null,
    deviceName: device ?? null,
    deviceLine: line ?? null,
  };
}

function makeWidget(id: string, sensorId: string): Widget {
  return {
    id,
    dashboardId: "d1",
    sensorId,
    type: "StatValue",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 4,
    gridHeight: 4,
    config: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

// 機器 r-1（電圧・電流）、機器 r-2（電圧）、機器に所属しない 1 つ
const devicesSensors = [
  makeSensor("s1", "ld01 電圧", "r-1"),
  makeSensor("s2", "ld01 電流", "r-1"),
  makeSensor("s3", "ld02 電圧", "r-2"),
  makeSensor("s4", "乾燥炉 温度"),
];

beforeEach(() => {
  window.localStorage.clear();
  useEditorStore.getState().reset();
  vi.mocked(api.fetchSensors).mockResolvedValue(devicesSensors);
  vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
  vi.mocked(api.fetchSensorReadingsAggregate).mockResolvedValue({ sum: 0, count: 0 });
  vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
  vi.mocked(api.fetchDashboard).mockResolvedValue(dashboard);
});

afterEach(() => {
  vi.restoreAllMocks();
  useEditorStore.getState().reset();
});

/** 機器の見出しの開閉ボタン（名前は「機器名（N 個）」） */
const groupToggle = (deviceName: string) => screen.getByRole("button", { name: new RegExp(`^${deviceName}（`) });

describe("センサー棚: 機器ごと", () => {
  it("機器に所属するセンサーがあると、機器ごとに分かれ（未所属は最後）、閉じたグループの行は出ない", async () => {
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    const headings = screen.getAllByRole("button", { name: /個）$/ }).map((b) => b.getAttribute("aria-label"));
    expect(headings).toEqual(["r-1（2 個）", "r-2（1 個）", "未所属（1 個）"]);
    expect(screen.queryByTitle("ld01 電圧")).not.toBeInTheDocument();

    await userEvent.setup().click(groupToggle("r-1"));
    expect(screen.getByTitle("ld01 電圧")).toBeInTheDocument();
    expect(screen.getByTitle("ld01 電流")).toBeInTheDocument();
    expect(screen.queryByTitle("ld02 電圧")).not.toBeInTheDocument();
  });

  it("「一覧」に切り替えると、従来どおり全センサーが並ぶ", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("button", { name: "一覧" }));
    for (const name of ["ld01 電圧", "ld01 電流", "ld02 電圧", "乾燥炉 温度"]) {
      expect(screen.getByTitle(name)).toBeInTheDocument();
    }
  });

  it("機器に所属するセンサーがなければ、並べ方の切り替えは出さず、一覧で表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("a", "温度"), makeSensor("b", "圧力")]);
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);

    expect(await screen.findByTitle("温度")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "センサーの並べ方" })).not.toBeInTheDocument();
  });

  it("機器名で検索すると、当たった機器だけが開いて表示され、文字が強調される", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "r-2");

    expect(screen.getByTitle("ld02 電圧")).toBeInTheDocument();
    expect(screen.queryByText("r-1")).not.toBeInTheDocument();
    expect(document.querySelector("mark")?.textContent).toBe("r-2");
    // 検索中は開きっぱなしで、見出しの開閉ボタンは押せない
    expect(groupToggle("r-2")).toBeDisabled();
  });

  it("「要注意のみ」は、未対応のアラームがあるセンサーだけに絞り、その機器の点は色が変わる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchAlarms).mockImplementation(async (status?: string) =>
      status === "active"
        ? {
            alarms: [
              {
                id: "al1",
                sensorId: "s3",
                triggeredAt: "2024-01-01T00:00:00.000Z",
                resolvedAt: null,
                acknowledgedAt: null,
                acknowledgedBy: null,
                value: 99,
                status: "active",
                thresholdBreached: "max",
                severity: "critical",
              },
            ],
            total: 1,
          }
        : { alarms: [], total: 0 },
    );
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-2");
    // 通常時は、アラームのない機器の点は緑、r-2 の点は赤
    await waitFor(() => expect(screen.getByTitle("重故障のアラームがあります")).toBeInTheDocument());
    // アラームのない機器（r-1・未所属）の点は緑
    expect(screen.getAllByTitle("未対応のアラームはありません")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "要注意のみ" }));
    expect(screen.getByTitle("ld02 電圧")).toBeInTheDocument();
    expect(screen.queryByText("r-1")).not.toBeInTheDocument();
    expect(screen.queryByTitle("ld01 電圧")).not.toBeInTheDocument();
  });
});

describe("センサー棚: チェックして一度に追加", () => {
  it("機器のチェックで全センサーを選び、一部を外すと「一部」の状態になる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    const groupCheck = screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" });
    await user.click(groupCheck);
    expect(screen.getByText(/^2 個を選択中/)).toBeInTheDocument();

    await user.click(groupToggle("r-1")); // 開いて、1 つ外す
    await user.click(screen.getByRole("checkbox", { name: "ld01 電流を選ぶ" }));
    expect(screen.getByText(/^1 個を選択中/)).toBeInTheDocument();
    expect((groupCheck as HTMLInputElement).indeterminate).toBe(true);
    expect((groupCheck as HTMLInputElement).checked).toBe(false);
  });

  /** addWidget が作ったウィジェットを返すモック（センサーの id をウィジェット id に使う） */
  const mockAddWidget = () =>
    vi.mocked(api.addWidget).mockImplementation(async (_dashboardId, body) => makeWidget(`w-${body.sensorId}`, body.sensorId as string));
  /** addWidget の呼び出しの引数（グラフの本文） */
  const addedBodies = () => vi.mocked(api.addWidget).mock.calls.map((call) => call[1]);

  it("検索を変えても選択は残り、「N 個を追加」で選んだ計測値を 1 つのグラフにまとめて追加し、選択を解除する", async () => {
    const user = userEvent.setup();
    mockAddWidget();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "乾燥");
    await user.click(screen.getByRole("checkbox", { name: "乾燥炉 温度を選ぶ" }));
    expect(screen.getByText(/^3 個を選択中/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "3 個を追加" }));

    // 1 つのグラフ（addWidget 1 回）に、3 つのセンサー。単位がそろっているので、縦軸は実際の値のまま
    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));
    const [graph] = addedBodies();
    expect(graph.type).toBe("SensorGraph");
    expect(graph.config?.sensorIds).toEqual(["s1", "s2", "s4"]);
    expect(graph.config?.axisMode).toBeUndefined();
    await waitFor(() => expect(screen.getByText("チェックして、まとめて追加")).toBeInTheDocument());
    expect(useEditorStore.getState().toast?.message).toBe("グラフ 1 つに 3 個を追加しました");
  });

  it("機器の「すべて追加」は、チェックなしでその機器の表示中のセンサーを 1 つのグラフにまとめる", async () => {
    const user = userEvent.setup();
    mockAddWidget();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    const header = screen.getByRole("button", { name: "r-1のセンサーをすべて追加" });
    expect(within(header.parentElement as HTMLElement).getByText("r-1")).toBeInTheDocument();
    await user.click(header);

    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));
    expect(addedBodies()[0].config?.sensorIds).toEqual(["s1", "s2"]);
  });

  it("選択中のグラフがあっても、一括追加はそのグラフに重ねず、新しいグラフを 1 つ作る", async () => {
    const user = userEvent.setup();
    const graph = { ...makeWidget("w-graph", "s4"), type: "SensorGraph" as const };
    const withGraph = { ...dashboard, widgets: [graph] };
    mockAddWidget();
    useEditorStore.getState().select("w-graph");
    renderWithQueryClient(<EditorShelf dashboard={withGraph} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
    await user.click(screen.getByRole("button", { name: "2 個を追加" }));

    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));
    expect(api.updateWidget).not.toHaveBeenCalled();
    expect(addedBodies()[0].config?.sensorIds).toEqual(["s1", "s2"]);
  });

  describe("種類・単位が混ざるとき", () => {
    const mixed = [
      makeSensor("v1", "ld01 電圧", "r-1", undefined, "V"),
      makeSensor("a1", "ld01 電流", "r-1", undefined, "A"),
      makeSensor("c1", "ld01 生産数", "r-1", undefined, "個"),
      makeSensor("t1", "ld01 稼働", "r-1", undefined, ""),
    ];

    it("計測値だけを 1 つのグラフにまとめ、生産数・稼働は、種類に合う既定のウィジェットを 1 つずつ作る（通知は 1 つ）", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchSensors).mockResolvedValue(mixed);
      mockAddWidget();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");

      await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
      await user.click(screen.getByRole("button", { name: "4 個を追加" }));

      await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(3));
      expect(addedBodies().map((b) => [b.type, b.sensorId])).toEqual([
        ["SensorGraph", "v1"],
        ["ProductionPlan", "c1"],
        ["ProductionStatus", "t1"],
      ]);
      expect(addedBodies()[0].config?.sensorIds).toEqual(["v1", "a1"]);
      await waitFor(() => expect(useEditorStore.getState().toast?.message).toBe("グラフ 1 つに 2 個、ほかに 2 個を追加しました"));
    });

    it("単位が違う計測値（V と A）が混ざるときは、縦軸をセンサーごとの 0〜100% にそろえる", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchSensors).mockResolvedValue(mixed);
      mockAddWidget();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");

      await user.click(groupToggle("r-1"));
      await user.click(screen.getByRole("checkbox", { name: "ld01 電圧を選ぶ" }));
      await user.click(screen.getByRole("checkbox", { name: "ld01 電流を選ぶ" }));
      await user.click(screen.getByRole("button", { name: "2 個を追加" }));

      await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));
      expect(addedBodies()[0].config).toMatchObject({ sensorIds: ["v1", "a1"], axisMode: "normalized" });
    });
  });

  it("途中で失敗したら、成功と失敗の数を 1 つの通知にまとめ、失敗したセンサーだけ選択に残す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([
      makeSensor("v1", "ld01 電圧", "r-1"),
      makeSensor("v2", "ld01 電流", "r-1"),
      makeSensor("c1", "ld01 生産数", "r-1", undefined, "個"),
    ]);
    vi.mocked(api.addWidget).mockResolvedValueOnce(makeWidget("w-ok", "v1")).mockRejectedValueOnce(new Error("boom"));
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
    await user.click(screen.getByRole("button", { name: "3 個を追加" })); // グラフは作れ、生産数のウィジェットが失敗する

    await waitFor(() => expect(useEditorStore.getState().toast?.message).toBe("グラフ 1 つに 2 個を追加しました（1 個は失敗）"));
    expect(screen.getByText(/^1 個を選択中/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" })).not.toBeChecked();
  });

  it("グラフが作れなかったときは、そのグラフの全センサーが失敗として選択に残る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.addWidget).mockRejectedValue(new Error("boom"));
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
    await user.click(screen.getByRole("button", { name: "2 個を追加" }));

    await waitFor(() => expect(useEditorStore.getState().toast?.message).toBe("2 個すべての追加に失敗しました"));
    expect(screen.getByText(/^2 個を選択中/)).toBeInTheDocument();
  });

  it("追加中は「追加」と「すべて追加」を押せず、二重に実行されない", async () => {
    const user = userEvent.setup();
    let finish: (widget: Widget) => void = () => undefined;
    vi.mocked(api.addWidget).mockImplementation(
      (_dashboardId, body) => new Promise<Widget>((resolve) => (finish = (widget) => resolve({ ...widget, sensorId: body.sensorId ?? null }))),
    );
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-2の表示中のセンサーをすべて選ぶ" }));
    const addButton = screen.getByRole("button", { name: "1 個を追加" });
    await user.click(addButton);
    await user.click(addButton); // 続けて押しても、何も起きない

    expect(await screen.findByRole("button", { name: "追加中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "r-1のセンサーをすべて追加" })).toBeDisabled();
    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));

    finish(makeWidget("w-1", "s3"));
    await waitFor(() => expect(screen.getByText("チェックして、まとめて追加")).toBeInTheDocument());
    expect(api.addWidget).toHaveBeenCalledTimes(1);
  });

  describe("多いときの確認", () => {
    const measureSensors = (count: number) =>
      Array.from({ length: count }, (_, index) => makeSensor(`m${index}`, `多数 ${index}`, "r-many"));

    it("計測値が 12 個を超えると、「1 つのグラフに入れる」か「12 本ずつ分ける」かを確認する（やめれば何も追加しない）", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchSensors).mockResolvedValue(measureSensors(30));
      mockAddWidget();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-many");

      await user.click(screen.getByRole("checkbox", { name: "r-manyの表示中のセンサーをすべて選ぶ" }));
      await user.click(screen.getByRole("button", { name: "30 個を追加" }));
      expect(screen.getByText(/30 個を 1 つのグラフに入れます。多いと見にくくなります/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "キャンセル" }));
      expect(api.addWidget).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "30 個を追加" }));
      await user.click(screen.getByRole("button", { name: "1 つのグラフに入れる" }));
      await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));
      expect(addedBodies()[0].config?.sensorIds).toHaveLength(30);
    });

    it("「12 本ずつ分ける」を選ぶと、12・12・6 本のグラフ 3 つになる", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchSensors).mockResolvedValue(measureSensors(30));
      mockAddWidget();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-many");

      await user.click(screen.getByRole("checkbox", { name: "r-manyの表示中のセンサーをすべて選ぶ" }));
      await user.click(screen.getByRole("button", { name: "30 個を追加" }));
      await user.click(screen.getByRole("button", { name: "12 本ずつ分ける" }));

      await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(3));
      expect(addedBodies().map((b) => b.config?.sensorIds?.length)).toEqual([12, 12, 6]);
      await waitFor(() => expect(useEditorStore.getState().toast?.message).toBe("グラフ 3 つに 30 個を追加しました"));
    });

    it("ちょうど 12 個までは、確認せずに 1 つのグラフにまとめる", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchSensors).mockResolvedValue(measureSensors(12));
      mockAddWidget();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-many");

      await user.click(screen.getByRole("checkbox", { name: "r-manyの表示中のセンサーをすべて選ぶ" }));
      await user.click(screen.getByRole("button", { name: "12 個を追加" }));

      await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("グラフにまとめない（生産数など）センサーが 30 個を超えるときは、それぞれ別のウィジェットになると確認する", async () => {
      const user = userEvent.setup();
      const counts = Array.from({ length: 31 }, (_, index) => makeSensor(`c${index}`, `生産数 ${index}`, "r-count", undefined, "個"));
      vi.mocked(api.fetchSensors).mockResolvedValue(counts);
      mockAddWidget();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-count");

      await user.click(screen.getByRole("checkbox", { name: "r-countの表示中のセンサーをすべて選ぶ" }));
      await user.click(screen.getByRole("button", { name: "31 個を追加" }));
      expect(screen.getByText(/31 個のセンサーを、それぞれ新しいウィジェットとして追加します/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "キャンセル" }));
      expect(api.addWidget).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "31 個を追加" }));
      await user.click(screen.getByRole("button", { name: "追加" }));
      await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(31));
    });
  });

  it("「表示中をすべて選択」は表示中の分だけを選び、もう一度押すと外す", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "電圧");
    await user.click(screen.getByRole("button", { name: "表示中をすべて選択" }));
    expect(screen.getByText(/^2 個を選択中/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "表示中の選択を外す" }));
    expect(screen.getByText("チェックして、まとめて追加")).toBeInTheDocument();
  });

  it("表示外の選択があるときは、棚の下に件数を出す", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "乾燥");

    expect(screen.getByText("2 個を選択中（うち 2 個は表示外）")).toBeInTheDocument();
  });

  describe("名前の語の絞り込み", () => {
    const chip = (word: string) => screen.getByRole("button", { name: new RegExp(`^${word}\\d`) });

    it("既定の語（電圧・電流・電位）のチップに、全センサー中の件数が付く", async () => {
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");

      expect(chip("電圧")).toHaveTextContent("電圧2");
      expect(chip("電流")).toHaveTextContent("電流1");
      expect(chip("電位")).toHaveTextContent("電位0");
    });

    it("語を選ぶと、名前に含むセンサーだけになり（機器ごと・一覧のどちらでも）、もう一度押すと解除される", async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");

      await user.click(chip("電圧"));
      expect(chip("電圧")).toHaveAttribute("aria-pressed", "true");
      // 機器ごと: 当たったグループは自動で開く（未所属は当たらないので出ない）
      expect(screen.getByTitle("ld01 電圧")).toBeInTheDocument();
      expect(screen.getByTitle("ld02 電圧")).toBeInTheDocument();
      expect(screen.queryByTitle("ld01 電流")).not.toBeInTheDocument();
      expect(screen.queryByText("未所属")).not.toBeInTheDocument();
      expect(groupToggle("r-1")).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "一覧" }));
      expect(screen.getAllByTitle(/電圧$/)).toHaveLength(2);
      expect(screen.queryByTitle("乾燥炉 温度")).not.toBeInTheDocument();

      await user.click(chip("電圧"));
      expect(chip("電圧")).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByTitle("乾燥炉 温度")).toBeInTheDocument();
    });

    it("「すべて」で解除でき、ほかの絞り込み（検索・種類・要注意）とは AND になる", async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");

      await user.click(chip("電圧"));
      await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "ld02");
      expect(screen.getByTitle("ld02 電圧")).toBeInTheDocument();
      expect(screen.queryByTitle("ld01 電圧")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "稼働" })); // 種類。この例のセンサーに稼働はない
      expect(screen.getByText("該当するセンサーがありません")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "すべて" }));

      // 語を「すべて」に戻しても、検索（ld02）は効いたまま
      await user.click(screen.getByRole("button", { name: "名前の語: すべて" }));
      expect(chip("電圧")).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByTitle("ld02 電圧")).toBeInTheDocument();
      expect(screen.queryByTitle("ld01 電圧")).not.toBeInTheDocument();
    });

    it("語で絞っても、チェックした選択は保たれる", async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");

      await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
      await user.click(chip("電圧"));

      expect(screen.getByText("2 個を選択中（うち 1 個は表示外）")).toBeInTheDocument();
    });

    it("語を追加すると、チップと件数が出て、選択でき、再読み込みしても残る", async () => {
      const user = userEvent.setup();
      const { unmount } = renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");

      await user.click(screen.getByRole("button", { name: "＋語を追加" }));
      await user.type(screen.getByLabelText("追加する語"), "温度");
      await user.click(screen.getByRole("button", { name: "語を追加" }));
      expect(chip("温度")).toHaveTextContent("温度1");
      await user.click(chip("温度"));
      expect(screen.getByTitle("乾燥炉 温度")).toBeInTheDocument();

      unmount();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByTitle("乾燥炉 温度");
      expect(chip("温度")).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByTitle("ld01 電圧")).not.toBeInTheDocument();
    });

    it("空・重複・長すぎる語は追加できず、理由を出す", async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");
      await user.click(screen.getByRole("button", { name: "＋語を追加" }));
      const submit = () => user.click(screen.getByRole("button", { name: "語を追加" }));

      await submit();
      expect(screen.getByRole("alert")).toHaveTextContent("語を入力してください");

      await user.type(screen.getByLabelText("追加する語"), "電圧");
      await submit();
      expect(screen.getByRole("alert")).toHaveTextContent("同じ語がすでにあります");

      await user.clear(screen.getByLabelText("追加する語"));
      await user.type(screen.getByLabelText("追加する語"), "あ".repeat(21));
      await submit();
      expect(screen.getByRole("alert")).toHaveTextContent("20 文字まで");
    });

    it("✕ で語を消せ（既定の語も）、「既定に戻す」で戻る。選択中の語を消すと絞り込みも外れる", async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");

      await user.click(chip("電圧"));
      await user.click(screen.getByRole("button", { name: "語「電圧」を削除" }));
      expect(screen.queryByRole("button", { name: /^電圧\d/ })).not.toBeInTheDocument();
      expect(screen.getByText("未所属")).toBeInTheDocument(); // 絞り込みが外れた（当たらなかった未所属も出る）

      await user.click(screen.getByRole("button", { name: "既定に戻す" }));
      expect(chip("電圧")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "既定に戻す" })).not.toBeInTheDocument();
    });

    it("保存した値が壊れていても、既定の語で動く", async () => {
      window.localStorage.setItem("factoreye.sensorShelfWords", "{oops");
      renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
      await screen.findByText("r-1");

      expect(chip("電圧")).toBeInTheDocument();
      expect(chip("電位")).toBeInTheDocument();
    });
  });
});

/** 系統の見出しの開閉ボタン（名前は「系統名（N 機器 / M 個）」） */
const lineToggle = (lineName: string) => screen.getByRole("button", { name: new RegExp(`^${lineName}（`) });

// 第1ライン: r-1（電圧・電流）、r-2（電圧）／ 第2ライン: r-3（電圧）／ 系統なし: r-4（電圧）と、機器に所属しない 1 つ
const lineSensors = [
  makeSensor("s1", "ld01 電圧", "r-1", "第1ライン"),
  makeSensor("s2", "ld01 電流", "r-1", "第1ライン"),
  makeSensor("s3", "ld02 電圧", "r-2", "第1ライン"),
  makeSensor("s4", "ld03 電圧", "r-3", "第2ライン"),
  makeSensor("s5", "ld04 電圧", "r-4"),
  makeSensor("s6", "乾燥炉 温度"),
];

describe("センサー棚: 系統 › 機器", () => {
  beforeEach(() => {
    vi.mocked(api.fetchSensors).mockResolvedValue(lineSensors);
  });

  it("系統があると既定は「系統 › 機器」。系統が名前順に並び、「系統なし」は最後で、開くまで機器・行は出ない", async () => {
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第1ライン");

    const headings = screen.getAllByRole("button", { name: /個）$/ }).map((b) => b.getAttribute("aria-label"));
    expect(headings).toEqual(["第1ライン（2 機器 / 3 個）", "第2ライン（1 機器 / 1 個）", "系統なし（2 機器 / 2 個）"]);
    expect(screen.getByRole("button", { name: "系統 › 機器" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("r-1")).not.toBeInTheDocument();
  });

  it("系統を開くと機器が、機器を開くとセンサーが出る。系統なしには、系統のない機器と未所属が入る", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第1ライン");

    await user.click(lineToggle("第1ライン"));
    expect(screen.getByText("r-1")).toBeInTheDocument();
    expect(screen.getByText("r-2")).toBeInTheDocument();
    expect(screen.queryByTitle("ld01 電圧")).not.toBeInTheDocument();
    await user.click(groupToggle("r-1"));
    expect(screen.getByTitle("ld01 電圧")).toBeInTheDocument();

    await user.click(lineToggle("系統なし"));
    expect(screen.getByText("r-4")).toBeInTheDocument();
    expect(screen.getByText("未所属")).toBeInTheDocument();
  });

  it("3 つの並べ方を切り替えられる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第1ライン");

    const layouts = within(screen.getByRole("group", { name: "センサーの並べ方" })).getAllByRole("button");
    expect(layouts.map((b) => b.textContent)).toEqual(["系統 › 機器", "機器ごと", "一覧"]);
    await user.click(screen.getByRole("button", { name: "機器ごと" }));
    expect(screen.queryByText("第1ライン")).not.toBeInTheDocument();
    expect(screen.getByText("r-1")).toBeInTheDocument();
  });

  it("系統が 1 つも無ければ、これまでどおり「機器ごと」「一覧」の 2 つだけ（既定は機器ごと）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue(devicesSensors);
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-2");

    const layouts = within(screen.getByRole("group", { name: "センサーの並べ方" })).getAllByRole("button");
    expect(layouts.map((b) => b.textContent)).toEqual(["機器ごと", "一覧"]);
    expect(layouts[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("系統名に空白や記号があっても、開閉ボタンの aria-controls が、開いた機器の一覧の id と一致する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("w1", "ld01 電圧", "r-1", "第 1 ライン / A棟")]);
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第 1 ライン / A棟");

    const toggle = lineToggle("第 1 ライン / A棟");
    await user.click(toggle);
    const controls = toggle.getAttribute("aria-controls") ?? "";
    expect(controls).not.toMatch(/\s/);
    const devices = document.getElementById(controls);
    expect(devices).not.toBeNull();
    expect(within(devices as HTMLElement).getByText("r-1")).toBeInTheDocument();
  });

  it("系統のチェックで、その系統の表示中のセンサーをすべて選べる（一部だけのときは「一部」の状態）", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第1ライン");

    const lineCheck = screen.getByRole("checkbox", { name: "第1ラインの表示中のセンサーをすべて選ぶ" });
    await user.click(lineCheck);
    expect(screen.getByText(/^3 個を選択中/)).toBeInTheDocument();

    await user.click(lineToggle("第1ライン"));
    await user.click(groupToggle("r-2"));
    await user.click(screen.getByRole("checkbox", { name: "ld02 電圧を選ぶ" }));
    expect(screen.getByText(/^2 個を選択中/)).toBeInTheDocument();
    expect((lineCheck as HTMLInputElement).indeterminate).toBe(true);
  });

  it("系統の見出しの点は、中のいちばん重いアラームの色になる", async () => {
    vi.mocked(api.fetchAlarms).mockImplementation(async (status?: string) => ({
      alarms:
        status === "active"
          ? [
              {
                id: "al1",
                sensorId: "s4",
                triggeredAt: "2024-01-01T00:00:00.000Z",
                resolvedAt: null,
                acknowledgedAt: null,
                acknowledgedBy: null,
                value: 9,
                status: "active" as const,
                thresholdBreached: "max" as const,
                severity: "warning" as const,
              },
            ]
          : [],
      total: status === "active" ? 1 : 0,
    }));
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第1ライン");

    await waitFor(() => expect(screen.getByTitle("軽故障のアラームがあります")).toBeInTheDocument());
    expect(screen.getAllByTitle("未対応のアラームはありません")).toHaveLength(2); // 第1ライン・系統なし
  });

  it("系統名で検索すると、当たった系統・機器がすべて開いて出る（開閉はできない）", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第1ライン");

    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "第2ライン");

    expect(screen.getByTitle("ld03 電圧")).toBeInTheDocument();
    expect(screen.queryByText("第1ライン")).not.toBeInTheDocument();
    expect(lineToggle("第2ライン")).toBeDisabled();
    expect(document.querySelector("mark")?.textContent).toBe("第2ライン");
  });

  it("名前の語の絞り込みとは AND。語で絞っている間は、当たった系統・機器を自動で開く", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第1ライン");

    await user.click(screen.getByRole("button", { name: /^電流\d/ }));
    expect(screen.getByTitle("ld01 電流")).toBeInTheDocument();
    expect(screen.queryByTitle("ld01 電圧")).not.toBeInTheDocument();
    expect(screen.queryByText("第2ライン")).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "ld09");
    expect(screen.getByText("該当するセンサーがありません")).toBeInTheDocument();
  });

  it("「すべて開く」は系統だけを開く（機器の行までは描かない）", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第1ライン");

    await user.click(screen.getByRole("button", { name: "すべて開く" }));
    expect(screen.getByText("r-1")).toBeInTheDocument();
    expect(screen.queryByTitle("ld01 電圧")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "すべて閉じる" }));
    expect(screen.queryByText("r-1")).not.toBeInTheDocument();
  });

  it("1,050 センサー・350 機器・7 系統でも、閉じている間は見出しだけを描き、開いた系統の機器の見出しだけが増える", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 350 }, (_, index) =>
      ["電圧", "電流", "電位"].map((kind) =>
        makeSensor(`m${index}-${kind}`, `ld${index} ${kind}`, `r-load-${index}`, `第${Math.floor(index / 50) + 1}ライン`),
      ),
    ).flat();
    vi.mocked(api.fetchSensors).mockResolvedValue(many);
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("第1ライン");

    expect(screen.getAllByRole("button", { name: /機器 \/ \d+ 個）$/ })).toHaveLength(7);
    expect(screen.queryAllByRole("checkbox", { name: /を選ぶ$/ }).filter((c) => c.getAttribute("aria-label")?.startsWith("ld"))).toHaveLength(0);

    await user.click(lineToggle("第1ライン"));
    expect(screen.getAllByRole("button", { name: /^r-load-\d+（3 個）$/ })).toHaveLength(50);
    expect(screen.queryByTitle("ld0 電圧")).not.toBeInTheDocument(); // 機器を開くまで、行は描かない
  });
});

describe("センサー棚: 窓を広げたときの読みやすさ", () => {
  it("棚の幅（container query）で切り替えるクラスが付いている（広げると名前が 1 行になり、値が右に並ぶ。index.css）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([makeSensor("a", "とても長いセンサーの名前 電圧")]);
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);

    const name = await screen.findByTitle("とても長いセンサーの名前 電圧");
    expect(name).toHaveClass("shelf-row-name", "line-clamp-2"); // 狭いときは従来どおり 2 行まで
    expect(name.parentElement).toHaveClass("shelf-row-main");
    expect(name.nextElementSibling).toHaveClass("shelf-row-meta");
    expect(name.closest(".shelf-scroll")).not.toBeNull();
  });
});
