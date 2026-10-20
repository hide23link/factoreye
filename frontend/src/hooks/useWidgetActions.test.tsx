import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { pendingSaves } from "../lib/pending-saves";
import { useEditorStore } from "../store/useEditorStore";
import type { DashboardDetail, Sensor, Widget } from "../types";
import { useWidgetActions } from "./useWidgetActions";

vi.mock("../lib/api", () => ({
  addWidget: vi.fn(),
  deleteWidget: vi.fn(),
  updateWidget: vi.fn(),
}));

import * as api from "../lib/api";

function widget(id: string, overrides: Partial<Widget> = {}): Widget {
  return {
    id,
    dashboardId: "d1",
    sensorId: "s1",
    type: "SensorGraph",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 4,
    gridHeight: 4,
    config: {},
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function dashboardOf(widgets: Widget[]): DashboardDetail {
  return { id: "d1", name: "D", description: null, layoutConfig: {}, widgets, createdAt: "", updatedAt: "" };
}

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

/** キャッシュに置いたダッシュボードを使う、操作のフック */
function setup(widgets: Widget[]) {
  client.setQueryData(["dashboard", "d1"], dashboardOf(widgets));
  return renderHook(() => useWidgetActions(dashboardOf(widgets)), { wrapper }).result;
}
const cached = () => client.getQueryData<DashboardDetail>(["dashboard", "d1"])!.widgets;

/** 呼ばれるまで終わらない Promise（通信の途中を作る） */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  useEditorStore.getState().reset();
  vi.mocked(api.updateWidget).mockImplementation(async (id) => widget(id));
  vi.mocked(api.deleteWidget).mockResolvedValue(undefined);
  vi.mocked(api.addWidget).mockImplementation(async (_d, data) => widget("new", { ...data }));
});
afterEach(() => vi.restoreAllMocks());

describe("削除の「元に戻す」", () => {
  it("押した時点の最新の操作ではなく、その削除だけを戻す（あとの操作は巻き込まない）", async () => {
    const result = setup([widget("a"), widget("b", { config: { graphType: "area" } })]);
    await act(() => result.current.remove(widget("a")));
    const toast = useEditorStore.getState().toast!;
    // 削除のあとに、別のウィジェットを変更する
    await act(() => result.current.patchConfig(widget("b"), { graphType: "bar" }));

    await act(async () => toast.action!.run());

    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.addWidget).mock.calls[0][1]).toMatchObject({ type: "SensorGraph", sensorId: "s1" });
    // b の変更は戻らない
    expect(cached().find((w) => w.id === "b")?.config).toEqual({ graphType: "bar" });
    expect(cached().some((w) => w.id === "new")).toBe(true);
  });
});

describe("元に戻すの直列化", () => {
  it("Ctrl+Z を続けて押しても、前の取り消しが終わってから次を実行する", async () => {
    const result = setup([widget("a", { config: { colors: ["#000000"] } })]);
    await act(() => result.current.patchConfig(widget("a"), { graphType: "area" }));
    await act(() => result.current.patchConfig(widget("a"), { graphType: "bar" }));
    vi.mocked(api.updateWidget).mockClear();

    const first = deferred<Widget>();
    vi.mocked(api.updateWidget).mockReturnValueOnce(first.promise);
    let done: Promise<unknown>[] = [];
    act(() => {
      done = [result.current.undo(), result.current.undo()];
    });
    await waitFor(() => expect(api.updateWidget).toHaveBeenCalledTimes(1));
    // 1 回目の通信が終わるまで、2 回目は始まらない
    await new Promise((r) => setTimeout(r, 30));
    expect(api.updateWidget).toHaveBeenCalledTimes(1);

    first.resolve(widget("a"));
    await act(async () => {
      await Promise.all(done);
    });
    expect(api.updateWidget).toHaveBeenCalledTimes(2);
    expect(cached()[0].config).toEqual({ colors: ["#000000"] });
    expect(useEditorStore.getState().history).toHaveLength(0);
  });

  it("元に戻すに失敗したら、その記録を残す（もう一度押せる）", async () => {
    const result = setup([widget("a")]);
    await act(() => result.current.patchConfig(widget("a"), { graphType: "bar" }));
    vi.mocked(api.updateWidget).mockRejectedValueOnce(new Error("network"));

    await act(() => result.current.undo());

    expect(useEditorStore.getState().history).toHaveLength(1);
    expect(useEditorStore.getState().toast?.message).toMatch(/元に戻す操作に失敗しました/);
  });
});

describe("設定の変更", () => {
  it("続けて別の項目を変えても、最新の設定に重ねて保存する（古い設定で上書きしない）", async () => {
    const result = setup([widget("a")]);
    const stale = widget("a"); // 呼び出し側が持っている古い表示
    await act(async () => {
      await Promise.all([
        result.current.patchConfig(stale, { graphType: "bar" }),
        result.current.patchConfig(stale, { rangeHours: 6 }),
      ]);
    });
    expect(cached()[0].config).toEqual({ graphType: "bar", rangeHours: 6 });
    const last = vi.mocked(api.updateWidget).mock.calls.at(-1)!;
    expect(last[1]).toMatchObject({ config: { graphType: "bar", rangeHours: 6 } });
  });

  it("変わらない操作は、通信も履歴もしない", async () => {
    const result = setup([widget("a", { config: { graphType: "bar" } })]);
    await act(() => result.current.patchConfig(widget("a"), { graphType: "bar" }));
    expect(api.updateWidget).not.toHaveBeenCalled();
    expect(useEditorStore.getState().history).toHaveLength(0);
  });

  it("保存に失敗したら、その操作の履歴だけを捨てる（先にあった記録は残す）", async () => {
    const result = setup([widget("a")]);
    await act(() => result.current.patchConfig(widget("a"), { graphType: "area" }));
    expect(useEditorStore.getState().history).toHaveLength(1);
    vi.mocked(api.updateWidget).mockRejectedValueOnce(new Error("network"));

    await act(() => result.current.patchConfig(widget("a"), { graphType: "bar" }));

    expect(useEditorStore.getState().history).toHaveLength(1);
  });

  it("保存の進行中は、取り直しを止める印が立ち、終わると下りる", async () => {
    const result = setup([widget("a")]);
    const slow = deferred<Widget>();
    vi.mocked(api.updateWidget).mockReturnValueOnce(slow.promise);
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.patchConfig(widget("a"), { graphType: "bar" });
    });
    await waitFor(() => expect(pendingSaves.isBusy()).toBe(true));
    slow.resolve(widget("a"));
    await act(async () => {
      await done;
    });
    expect(pendingSaves.isBusy()).toBe(false);
  });
});

describe("種類の変更", () => {
  it("新しいウィジェットを作れなかったとき、元のウィジェットは消さない", async () => {
    const result = setup([widget("a", { type: "ProductionPlan" })]);
    vi.mocked(api.addWidget).mockRejectedValueOnce(new Error("network"));

    await act(() => result.current.changeType(widget("a", { type: "ProductionPlan" }), "SensorGraph"));

    expect(api.deleteWidget).not.toHaveBeenCalled();
    expect(cached().map((w) => w.id)).toEqual(["a"]);
    expect(useEditorStore.getState().history).toHaveLength(0);
  });

  it("作れたら元のものを消し、新しいものに入れ替える", async () => {
    const result = setup([widget("a", { type: "ProductionPlan" })]);
    await act(() => result.current.changeType(widget("a", { type: "ProductionPlan" }), "SensorGraph"));
    expect(api.deleteWidget).toHaveBeenCalledWith("a");
    expect(cached().map((w) => w.id)).toEqual(["new"]);
  });
});

describe("センサーの追加で自動作成したとき", () => {
  const sensor = (name: string, unit: string): Sensor => ({
    id: "sx",
    name,
    ingestKey: "sx",
    unit,
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: null,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "",
    updatedAt: "",
  });

  it("グラフ以外（生産管理）には「グラフにする」が付く", async () => {
    const result = setup([]);
    await act(() => result.current.addSensor(sensor("ライン1 生産数", "個")));
    expect(useEditorStore.getState().toast?.action?.label).toBe("グラフにする");
  });

  it("グラフには「数値にする」が付く", async () => {
    const result = setup([]);
    await act(() => result.current.addSensor(sensor("温度", "℃")));
    expect(useEditorStore.getState().toast?.action?.label).toBe("数値にする");
  });
});
