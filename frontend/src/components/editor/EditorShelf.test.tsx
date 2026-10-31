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

function makeSensor(id: string, name: string, device?: string): Sensor {
  return {
    id,
    name,
    ingestKey: id,
    unit: "V",
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

  it("検索を変えても選択は残り、「N 個を追加」で選んだ分を追加して選択を解除する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.addWidget).mockImplementation(async (_dashboardId, body) => makeWidget(`w-${body.sensorId}`, body.sensorId as string));
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "乾燥");
    await user.click(screen.getByRole("checkbox", { name: "乾燥炉 温度を選ぶ" }));
    expect(screen.getByText(/^3 個を選択中/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "3 個を追加" }));

    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(3));
    const sensorIds = vi.mocked(api.addWidget).mock.calls.map((call) => call[1].sensorId).sort();
    expect(sensorIds).toEqual(["s1", "s2", "s4"]);
    await waitFor(() => expect(screen.getByText("チェックして、まとめて追加")).toBeInTheDocument());
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

  it("機器の「すべて追加」は、チェックなしでその機器のセンサーを追加する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.addWidget).mockImplementation(async (_dashboardId, body) => makeWidget(`w-${body.sensorId}`, body.sensorId as string));
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    const header = screen.getByRole("button", { name: "r-1のセンサーをすべて追加" });
    expect(within(header.parentElement as HTMLElement).getByText("r-1")).toBeInTheDocument();
    await user.click(header);

    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(2));
  });

  it("選択中のグラフがあっても、一括追加はグラフに重ねず、センサーごとに新しいウィジェットを作る", async () => {
    const user = userEvent.setup();
    const graph = { ...makeWidget("w-graph", "s4"), type: "SensorGraph" as const };
    const withGraph = { ...dashboard, widgets: [graph] };
    vi.mocked(api.addWidget).mockImplementation(async (_dashboardId, body) => makeWidget(`w-${body.sensorId}`, body.sensorId as string));
    useEditorStore.getState().select("w-graph");
    renderWithQueryClient(<EditorShelf dashboard={withGraph} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
    await user.click(screen.getByRole("button", { name: "2 個を追加" }));

    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(2));
    expect(api.updateWidget).not.toHaveBeenCalled();
    expect(vi.mocked(api.addWidget).mock.calls.map((call) => call[1].sensorId).sort()).toEqual(["s1", "s2"]);
  });

  it("途中で失敗したら、成功と失敗の数を 1 つの通知にまとめ、失敗したセンサーだけ選択に残す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.addWidget)
      .mockResolvedValueOnce(makeWidget("w-ok", "s1"))
      .mockRejectedValueOnce(new Error("boom"));
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
    await user.click(screen.getByRole("button", { name: "2 個を追加" }));

    await waitFor(() => expect(useEditorStore.getState().toast?.message).toBe("2 個中 1 個を追加しました（1 個は失敗）"));
    expect(screen.getByText(/^1 個を選択中/)).toBeInTheDocument();
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

  it("30 個を超える一括追加は、確認してから実行する（やめれば何も追加しない）", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 31 }, (_, index) => makeSensor(`m${index}`, `多数 ${index}`, "r-many"));
    vi.mocked(api.fetchSensors).mockResolvedValue(many);
    vi.mocked(api.addWidget).mockImplementation(async (_dashboardId, body) => makeWidget(`w-${body.sensorId}`, body.sensorId as string));
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-many");

    await user.click(screen.getByRole("checkbox", { name: "r-manyの表示中のセンサーをすべて選ぶ" }));
    await user.click(screen.getByRole("button", { name: "31 個を追加" }));
    expect(screen.getByText(/31 個のセンサーを、それぞれ新しいウィジェットとして追加します/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(api.addWidget).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "31 個を追加" }));
    await user.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(31));
  });

  it("表示外の選択があるときは、棚の下に件数を出す", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EditorShelf dashboard={dashboard} />);
    await screen.findByText("r-1");

    await user.click(screen.getByRole("checkbox", { name: "r-1の表示中のセンサーをすべて選ぶ" }));
    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "乾燥");

    expect(screen.getByText("2 個を選択中（うち 2 個は表示外）")).toBeInTheDocument();
  });
});
