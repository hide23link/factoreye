import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, createEvent, fireEvent, renderWithQueryClient, screen, waitFor, within } from "../test/test-utils";
import { useEditorStore } from "../store/useEditorStore";
import * as panelPlacement from "../lib/panel-placement";
import { useUiStore } from "../store/useUiStore";
import type { DashboardDetail, Sensor, Widget } from "../types";
import { DashboardView } from "./DashboardView";

vi.mock("../lib/api", () => ({
  fetchDashboard: vi.fn(),
  deleteDashboard: vi.fn(),
  updateDashboard: vi.fn(),
  updateWidget: vi.fn(),
  addWidget: vi.fn(),
  deleteWidget: vi.fn(),
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchSensorReadingsAggregate: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  fetchAlarms: vi.fn(),
}));

import * as api from "../lib/api";

const emptyDashboard: DashboardDetail = {
  id: "d1",
  name: "工場A",
  description: "メイン工場の監視",
  layoutConfig: {},
  widgets: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function makeSensor(id: string, name: string, unit = "℃"): Sensor {
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
  };
}

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

/** jsdom の DragEvent は座標を持たないので、座標つきのドラッグイベントを作って送る */
function sendDrag(type: "dragOver" | "drop", element: Element, x: number, y: number, shiftKey = false) {
  const event = createEvent[type](element, { dataTransfer: { dropEffect: "none" }, shiftKey });
  Object.defineProperty(event, "clientX", { value: x });
  Object.defineProperty(event, "clientY", { value: y });
  fireEvent(element, event);
}

const sensors = [makeSensor("s1", "乾燥炉 温度"), makeSensor("s2", "ライン1 生産数", "個"), makeSensor("s3", "ライン1 稼働", "")];

beforeEach(() => {
  useEditorStore.getState().reset();
  vi.mocked(api.fetchSensors).mockResolvedValue(sensors);
  vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
  vi.mocked(api.fetchSensorReadingsAggregate).mockResolvedValue({ sum: 0, count: 0 });
  vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  useEditorStore.getState().reset();
});

describe("DashboardView", () => {
  it("ローディング中はスピナーテキストを表示する", () => {
    vi.mocked(api.fetchDashboard).mockReturnValue(new Promise(() => {}));

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
  });

  it("取得に失敗したとき、エラーと再試行・一覧へ戻る導線を表示する", async () => {
    vi.mocked(api.fetchDashboard).mockRejectedValue(new Error("boom"));

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    expect(await screen.findByText("ダッシュボードを取得できませんでした。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再試行" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "← 一覧へ" })).toBeInTheDocument();
    expect(screen.queryByText("読み込み中...")).not.toBeInTheDocument();
  });

  it("ダッシュボード名と説明を表示する", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    expect(await screen.findByText("工場A")).toBeInTheDocument();
    expect(screen.getByText("メイン工場の監視")).toBeInTheDocument();
  });

  it("ウィジェットが0件のときガイドメッセージを表示する", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<DashboardView dashboardId="d1" />);

    expect(await screen.findByText(/まだウィジェットがありません/)).toBeInTheDocument();
  });

  describe("編集モード", () => {
    // センサー棚は、広い画面（1600px 以上）でだけ最初から開く。テストは広い画面として動かす
    const originalWidth = window.innerWidth;
    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", { value: 1700, configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    });

    it("「編集する」で、センサー棚が出る。設定パネルと部品バーは、ボタンで開閉できる。「編集を終わる」で全部消える", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);

      expect(screen.queryByRole("complementary", { name: "センサー棚" })).not.toBeInTheDocument();
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));

      // センサーとウィジェットは別の窓（タブで 1 つの窓に入れない）
      expect(screen.getByRole("complementary", { name: "センサー棚" })).toBeInTheDocument();
      expect(screen.queryByRole("tab")).not.toBeInTheDocument();
      expect(await screen.findByText("乾燥炉 温度")).toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "ウィジェットの種類" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "ウィジェット" }));
      expect(screen.getByRole("group", { name: "ウィジェットの種類" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "設定" }));
      expect(screen.getByRole("complementary", { name: "設定パネル" })).toBeInTheDocument();
      expect(screen.getByText("ダッシュボードの設定")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "センサー棚を閉じる" }));
      expect(screen.queryByRole("complementary", { name: "センサー棚" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "設定パネルを閉じる" }));
      expect(screen.queryByRole("complementary", { name: "設定パネル" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "編集を終わる" }));
      expect(screen.queryByRole("group", { name: "ウィジェットの種類" })).not.toBeInTheDocument();
    });

    it("名前を変えて入力欄を離れると、updateDashboard で保存する（保存ボタンは無い）", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
      vi.mocked(api.updateDashboard).mockResolvedValue({ ...emptyDashboard, name: "工場A更新" });

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(screen.getByRole("button", { name: "設定" }));

      const nameInput = screen.getByRole("textbox", { name: "名前" });
      await user.clear(nameInput);
      await user.type(nameInput, "工場A更新");
      await user.tab();

      await waitFor(() =>
        expect(api.updateDashboard).toHaveBeenCalledWith("d1", expect.objectContaining({ name: "工場A更新" })),
      );
      expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    });

    it("名前を空にして離れても保存しない（名前は必須）", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(screen.getByRole("button", { name: "設定" }));

      await user.clear(screen.getByRole("textbox", { name: "名前" }));
      await user.tab();

      expect(api.updateDashboard).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "名前" })).toHaveValue("工場A");
    });

    it("名前を空にして離れると、理由を出して元の名前に戻す", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(screen.getByRole("button", { name: "設定" }));
      await user.clear(screen.getByRole("textbox", { name: "名前" }));
      await user.tab();

      expect(screen.getByRole("alert")).toHaveTextContent("名前は空にできません");
    });

    it("名前の保存中は、入力した名前を表示し続ける（古い名前に一瞬戻らない）", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
      vi.mocked(api.updateDashboard).mockReturnValue(new Promise(() => {}));

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(screen.getByRole("button", { name: "設定" }));
      const input = screen.getByRole("textbox", { name: "名前" });
      await user.clear(input);
      await user.type(input, "新しい名前");
      await user.tab();

      await waitFor(() => expect(api.updateDashboard).toHaveBeenCalled());
      expect(screen.getByRole("textbox", { name: "名前" })).toHaveValue("新しい名前");
    });

    it("ダッシュボードの削除は、確認のあとで deleteDashboard を呼ぶ", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
      vi.mocked(api.deleteDashboard).mockResolvedValue(undefined);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(screen.getByRole("button", { name: "設定" }));

      await user.click(screen.getByRole("button", { name: "このダッシュボードを削除" }));
      expect(api.deleteDashboard).not.toHaveBeenCalled();
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "削除" }));

      await waitFor(() => expect(api.deleteDashboard).toHaveBeenCalledWith("d1"));
    });

    it("計測値のセンサーの「＋」で、グラフを新しく作る", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
      vi.mocked(api.addWidget).mockResolvedValue(makeWidget({ id: "w9", type: "SensorGraph", sensorId: "s1" }));

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(await screen.findByRole("button", { name: "乾燥炉 温度を追加" }));

      await waitFor(() =>
        expect(api.addWidget).toHaveBeenCalledWith(
          "d1",
          expect.objectContaining({ type: "SensorGraph", sensorId: "s1", gridColumn: 1, gridRow: 1 }),
        ),
      );
    });

    it("生産数のセンサーは生産管理、稼働のセンサーは稼働ステータスになる", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
      vi.mocked(api.addWidget).mockResolvedValue(makeWidget({ id: "w9" }));

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(await screen.findByRole("button", { name: "ライン1 生産数を追加" }));
      await user.click(await screen.findByRole("button", { name: "ライン1 稼働を追加" }));

      await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(2));
      const types = vi.mocked(api.addWidget).mock.calls.map((c) => c[1].type);
      expect(types).toEqual(["ProductionPlan", "ProductionStatus"]);
    });

    it("センサーを検索と種類で絞り込める", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await screen.findByText("乾燥炉 温度");

      await user.click(screen.getByRole("button", { name: "生産数" }));
      expect(screen.queryByText("乾燥炉 温度")).not.toBeInTheDocument();
      expect(screen.getByText("ライン1 生産数")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "すべて" }));
      await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "稼働");
      expect(screen.queryByText("乾燥炉 温度")).not.toBeInTheDocument();
      expect(screen.getByText("ライン1 稼働")).toBeInTheDocument();
    });

    it("ウィジェット棚のクリックで、種類を追加できる", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
      vi.mocked(api.addWidget).mockResolvedValue(makeWidget({ id: "w9", type: "ProductionPlan" }));

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(screen.getByRole("button", { name: "ウィジェット" }));
      await user.click(screen.getByRole("button", { name: /生産管理/ }));

      await waitFor(() =>
        expect(api.addWidget).toHaveBeenCalledWith(
          "d1",
          expect.objectContaining({ type: "ProductionPlan", gridWidth: 6, gridHeight: 9, config: {} }),
        ),
      );
    });

    it("ウィジェットを選ぶと設定パネルがそのウィジェットの設定になり、変更はすぐ updateWidget で保存される", async () => {
      const user = userEvent.setup();
      const widget = makeWidget({ id: "w1", type: "SensorGraph", sensorId: "s1", config: { graphType: "line" } });
      vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [widget] });
      vi.mocked(api.updateWidget).mockResolvedValue(widget);
      vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(await screen.findByRole("group", { name: "グラフ" }));

      expect(await screen.findByText("グラフの設定")).toBeInTheDocument();
      await user.click(screen.getByRole("radio", { name: "面" }));

      await waitFor(() =>
        expect(api.updateWidget).toHaveBeenCalledWith("w1", expect.objectContaining({ config: expect.objectContaining({ graphType: "area" }) })),
      );
    });

    it("削除したあと、Ctrl+Z で作り直せる（元に戻す）", async () => {
      const user = userEvent.setup();
      const widget = makeWidget({ id: "w1", type: "AlarmAlert", config: { foo: 1 } as Widget["config"] });
      // 削除したあとの取り直しでは、ウィジェットが無い状態を返す
      vi.mocked(api.fetchDashboard)
        .mockResolvedValueOnce({ ...emptyDashboard, widgets: [widget] })
        .mockResolvedValue(emptyDashboard);
      vi.mocked(api.deleteWidget).mockResolvedValue(undefined);
      vi.mocked(api.addWidget).mockResolvedValue(widget);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(await screen.findByLabelText("ウィジェットを削除"));
      await waitFor(() => expect(api.deleteWidget).toHaveBeenCalledWith("w1"));
      expect(await screen.findAllByRole("button", { name: "元に戻す" })).toHaveLength(2); // 上部のボタンと、通知のボタン

      await user.keyboard("{Control>}z{/Control}");

      await waitFor(() =>
        expect(api.addWidget).toHaveBeenCalledWith("d1", expect.objectContaining({ type: "AlarmAlert", config: { foo: 1 } })),
      );
    });

    it("履歴が空のとき、「元に戻す」は押せない", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));

      expect(screen.getByRole("button", { name: "元に戻す" })).toBeDisabled();
    });

    describe("閲覧と編集で、画面の構造（位置・大きさに関わる部分）が変わらない", () => {
      /** ウィジェットの枠と、格子を包む枠の「寸法に関わる」class を取り出す（編集専用の飾りは含めない） */
      function layoutSignature(container: HTMLElement) {
        const grid = container.querySelector(".layout") as HTMLElement;
        const card = container.querySelector("[data-widget-id]") as HTMLElement;
        const sizing = (el: HTMLElement) =>
          el.className
            .split(/\s+/)
            // 選択の強調（色の変更と outline）・つかむ手の形は、寸法に影響しない
            .filter((c) => !/^(widget-drag-handle|cursor-|touch-|active:|border-(blue|gray)-|outline)/.test(c))
            .sort()
            .join(" ");
        return {
          surface: sizing(grid.parentElement as HTMLElement),
          card: sizing(card),
          // カード直下の子（中身の包み）の数。編集で見出しの帯などが増えていないこと（飾りは absolute の 1 つだけ）
          cardChildren: Array.from(card.children).filter((c) => !(c as HTMLElement).className.includes("absolute")).length,
          gridChildren: grid.children.length,
        };
      }

      it("格子を包む枠・ウィジェットの枠・中身の包みが、編集の前後で同じ。編集用の窓は画面に固定して重ねる", async () => {
        const user = userEvent.setup();
        const widget = makeWidget({ id: "w1", type: "AlarmAlert", gridWidth: 6, gridHeight: 5 });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [widget] });

        const { container } = renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await screen.findByRole("group", { name: "アラーム一覧" });
        const before = layoutSignature(container);

        await user.click(screen.getByRole("button", { name: "✎ 編集する" }));
        await screen.findByRole("complementary", { name: "センサー棚" });
        await user.click(screen.getByRole("button", { name: "設定" }));
        const after = layoutSignature(container);

        expect(after).toEqual(before);
        // 棚と設定パネルは、流れの中に置かず（キャンバスの幅を縮めない）、画面に固定して重ねる
        expect(screen.getByRole("complementary", { name: "センサー棚" }).className).toContain("fixed");
        expect(screen.getByRole("complementary", { name: "設定パネル" }).className).toContain("fixed");
        // 編集用の飾り（複製・削除・つかむ目印）は、カードの中で absolute に重ねる
        const delButton = screen.getByRole("button", { name: "ウィジェットを削除" });
        expect(delButton.parentElement!.className).toContain("absolute");
      });

      it("編集中も、react-grid-layout の列数・余白・行の高さは閲覧と同じ（幅 768px 以上）", async () => {
        const user = userEvent.setup();
        const widget = makeWidget({ id: "w1", type: "AlarmAlert", gridColumn: 3, gridRow: 2, gridWidth: 6, gridHeight: 5 });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [widget] });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        const cell = async () => (await screen.findByRole("group", { name: "アラーム一覧" })).parentElement!;
        const viewStyle = (await cell()).style.cssText;

        await user.click(screen.getByRole("button", { name: "✎ 編集する" }));
        const editStyle = (await cell()).style.cssText;

        // transform（位置）と幅・高さが同じ
        expect(editStyle).toBe(viewStyle);
      });
    });

    it("画面に見えていないセンサー行は、データを取りに行かない", async () => {
      const user = userEvent.setup();
      // 何も画面に入らない IntersectionObserver
      class NeverVisible {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal("IntersectionObserver", NeverVisible);
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await screen.findByText("乾燥炉 温度");

      expect(api.fetchSensorReadings).not.toHaveBeenCalled();
      expect(api.fetchSensorReadingsAggregate).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("Delete で選択中のウィジェットを削除するが、Backspace では削除しない", async () => {
      const user = userEvent.setup();
      const widget = makeWidget({ id: "w1", type: "AlarmAlert" });
      vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [widget] });
      vi.mocked(api.deleteWidget).mockResolvedValue(undefined);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(await screen.findByRole("group", { name: "アラーム一覧" }));

      await user.keyboard("{Backspace}");
      expect(api.deleteWidget).not.toHaveBeenCalled();
      await user.keyboard("{Delete}");
      await waitFor(() => expect(api.deleteWidget).toHaveBeenCalledWith("w1"));
    });

    describe("設定パネルの位置（選んだウィジェットを覆わない）", () => {
      /** 画面の幅 1280px で、widget の id ごとに画面上の位置を返すようにする（jsdom には寸法が無いため） */
      // widget 以外の要素（時間の操作など）の矩形の下端。スクロールの模擬で変える
      let otherBottom = 0;
      function mockWidgetRects(rects: Record<string, [number, number]>) {
        otherBottom = 100;
        Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
          const range = rects[this.dataset.widgetId ?? ""];
          if (!range) return { left: 0, right: 0, top: otherBottom - 40, bottom: otherBottom, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
          return { left: range[0], right: range[1], top: 200, bottom: 420, width: range[1] - range[0], height: 220, x: range[0], y: 200, toJSON() {} };
        });
      }

      const threeWidgets = [
        makeWidget({ id: "left", type: "AlarmAlert", gridColumn: 1, gridWidth: 4 }),
        makeWidget({ id: "mid", type: "AlarmAlert", gridColumn: 5, gridWidth: 4 }),
        makeWidget({ id: "right", type: "AlarmAlert", gridColumn: 9, gridWidth: 4 }),
      ];

      it("左端・中央のウィジェットを選ぶと右に、右端のウィジェットを選ぶと左に出す（覆われない）", async () => {
        const user = userEvent.setup();
        mockWidgetRects({ left: [16, 330], mid: [340, 700], right: [710, 1264] });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: threeWidgets });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        const cards = await screen.findAllByRole("group", { name: "アラーム一覧" });
        const panel = () => screen.getByRole("complementary", { name: "設定パネル" });

        await user.click(cards.find((c) => c.dataset.widgetId === "left")!);
        expect(panel()).toHaveAttribute("data-placement", "right");
        await user.click(cards.find((c) => c.dataset.widgetId === "mid")!);
        expect(panel()).toHaveAttribute("data-placement", "right");
        await user.click(cards.find((c) => c.dataset.widgetId === "right")!);
        expect(panel()).toHaveAttribute("data-placement", "left");
      });

      it("左右どちらにも掛かる幅広のウィジェットは、下に出す", async () => {
        const user = userEvent.setup();
        mockWidgetRects({ wide: [16, 1264] });
        const wide = makeWidget({ id: "wide", type: "AlarmAlert", gridColumn: 1, gridWidth: 12 });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [wide] });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await user.click(await screen.findByRole("group", { name: "アラーム一覧" }));

        expect(screen.getByRole("complementary", { name: "設定パネル" })).toHaveAttribute("data-placement", "bottom");
      });

      it("下に出す設定パネルは、開いているセンサー棚の右隣から始まり、棚と重ならない", async () => {
        const user = userEvent.setup();
        mockWidgetRects({ wide: [16, 1264] });
        const wide = makeWidget({ id: "wide", type: "AlarmAlert", gridColumn: 1, gridWidth: 12 });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [wide] });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await user.click(screen.getByRole("button", { name: "センサー" })); // 棚を開く
        await user.click(await screen.findByRole("group", { name: "アラーム一覧" }));

        const panel = screen.getByRole("complementary", { name: "設定パネル" });
        expect(panel).toHaveAttribute("data-placement", "bottom");
        // 棚（左 8 + 幅 272）の右隣。棚が閉じていれば 8
        expect(panel.style.left).toBe("288px");
        await user.click(screen.getByRole("button", { name: "センサー棚を閉じる" }));
        expect(screen.getByRole("complementary", { name: "設定パネル" }).style.left).toBe("8px");
      });

      it("狭い画面（640px 未満）では、下部ナビ（56px）に隠れないよう、窓を上げて出す", async () => {
        const user = userEvent.setup();
        mockWidgetRects({ wide: [16, 560] });
        Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
        const wide = makeWidget({ id: "wide", type: "AlarmAlert", gridColumn: 1, gridWidth: 12 });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [wide] });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await user.click(await screen.findByRole("group", { name: "アラーム一覧" }));

        const panel = screen.getByRole("complementary", { name: "設定パネル" });
        expect(panel).toHaveAttribute("data-placement", "bottom");
        expect(panel.style.bottom).toBe("64px");
      });

      it("棚を動かした位置に合わせて、設定パネルは棚と重ならない側に出る", async () => {
        const user = userEvent.setup();
        mockWidgetRects({ mid: [400, 900] });
        const mid = makeWidget({ id: "mid", type: "AlarmAlert", gridColumn: 4, gridWidth: 6 });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [mid] });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await user.click(screen.getByRole("button", { name: "センサー" }));
        // 棚を右端（右のパネルの位置）へ動かす
        act(() => useEditorStore.getState().setShelfPos({ x: 980, y: 200 }, { persist: false }));
        await user.click(await screen.findByRole("group", { name: "アラーム一覧" }));

        const panel = screen.getByRole("complementary", { name: "設定パネル" });
        // 右は棚と重なるので、左端に出る
        expect(panel).toHaveAttribute("data-placement", "left");
        expect(panel.style.left).toBe("8px");
      });

      it("既定の位置の棚は、スクロールで窓の上端が変わっても、設定パネルの位置を測り直さない（切り替わらない）", async () => {
        const user = userEvent.setup();
        mockWidgetRects({ wide: [16, 1264] });
        const wide = makeWidget({ id: "wide", type: "AlarmAlert", gridColumn: 1, gridWidth: 12 });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [wide] });
        const spy = vi.spyOn(panelPlacement, "choosePanelSlot");

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await user.click(screen.getByRole("button", { name: "センサー" }));
        await user.click(await screen.findByRole("group", { name: "アラーム一覧" }));
        await waitFor(() => expect(screen.getByRole("complementary", { name: "設定パネル" })).toHaveAttribute("data-placement", "bottom"));
        const calls = spy.mock.calls.length;

        // スクロール: 時間の操作の位置が変わり、窓の上端（drawerTop）が変わる
        otherBottom = -300;
        act(() => {
          window.dispatchEvent(new Event("scroll"));
        });
        await new Promise((r) => setTimeout(r, 80));

        expect(spy.mock.calls.length).toBe(calls);
        expect(screen.getByRole("complementary", { name: "設定パネル" })).toHaveAttribute("data-placement", "bottom");
      });

      it("ドラッグ中は棚を隠すが、設定パネルは隠さず、パネルの枠にセンサーを置ける", async () => {
        const user = userEvent.setup();
        const graph = makeWidget({ id: "g1", type: "SensorGraph", sensorId: "s1", config: { graphType: "line" } });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [graph] });
        vi.mocked(api.updateWidget).mockResolvedValue(graph);
        vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await user.click(await screen.findByRole("group", { name: "グラフ" }));
        await screen.findByRole("complementary", { name: "センサー棚" });

        act(() => useEditorStore.getState().setDragging({ kind: "sensor", sensorId: "s2" }));
        await waitFor(() => expect(screen.getByRole("complementary", { name: "センサー棚" }).className).toContain("opacity-0"));
        expect(screen.getByRole("complementary", { name: "設定パネル" }).className).not.toContain("opacity-0");

        fireEvent.dragOver(screen.getByTestId("sensor-dropzone"), { dataTransfer: { dropEffect: "none" } });
        fireEvent.drop(screen.getByTestId("sensor-dropzone"), { dataTransfer: { dropEffect: "none" } });
        await waitFor(() =>
          expect(api.updateWidget).toHaveBeenCalledWith("g1", expect.objectContaining({ config: expect.objectContaining({ sensorIds: ["s1", "s2"] }) })),
        );
      });
    });

    it("空のキャンバスの案内: 棚が閉じているときは［センサー］を押すよう案内し、ボタンで棚を開ける", async () => {
      const user = userEvent.setup();
      // 1600px 未満では、棚は閉じて始まる
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));

      expect(screen.queryByRole("complementary", { name: "センサー棚" })).not.toBeInTheDocument();
      expect(screen.getByText(/上の［センサー］を押して一覧を開き/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "センサーを開く" }));
      expect(screen.getByRole("complementary", { name: "センサー棚" })).toBeInTheDocument();
      expect(screen.getByText(/左の一覧から/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "センサーを開く" })).not.toBeInTheDocument();
    });

    describe("センサー棚を動かせる", () => {
      const aside = () => screen.getByRole("complementary", { name: "センサー棚" });
      const handle = () => screen.getByTestId("shelf-handle");
      const leftOf = () => Number.parseInt(aside().style.left, 10);
      const topOf = () => Number.parseInt(aside().style.top, 10);

      async function openEditor() {
        const user = userEvent.setup();
        vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await screen.findByRole("complementary", { name: "センサー棚" });
        return user;
      }

      beforeEach(() => {
        window.localStorage.clear();
        useEditorStore.getState().reset();
      });
      afterEach(() => window.localStorage.clear());

      /** jsdom の PointerEvent は座標を持たないので、座標つきのイベントを作って送る */
      function pointer(type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) {
        const event = createEvent[type](handle());
        Object.defineProperty(event, "clientX", { value: x });
        Object.defineProperty(event, "clientY", { value: y });
        fireEvent(handle(), event);
      }

      it("見出しにフォーカスして矢印キーで動く（Shift で大きく）。位置は保存される", async () => {
        const user = await openEditor();
        handle().focus();

        await user.keyboard("{ArrowRight}");
        const first = leftOf();
        await user.keyboard("{ArrowRight}");
        expect(leftOf() - first).toBe(16);
        await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
        const y1 = topOf();
        await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
        expect(topOf() - y1).toBe(64);

        expect(JSON.parse(window.localStorage.getItem("factoreye.sensorShelfPosition")!)).toEqual({ x: leftOf(), y: topOf() });
      });

      it("見出しをつかんで動かせる。動かし終えたときに保存する", async () => {
        await openEditor();
        pointer("pointerDown", 100, 100);
        pointer("pointerMove", 160, 130);
        expect(leftOf()).toBe(60);
        expect(topOf()).toBe(30);
        // 途中では保存しない
        expect(window.localStorage.getItem("factoreye.sensorShelfPosition")).toBeNull();
        pointer("pointerUp", 160, 130);
        expect(JSON.parse(window.localStorage.getItem("factoreye.sensorShelfPosition")!)).toEqual({ x: 60, y: 30 });
      });

      it("画面の外へは動かせない（見出しは常に画面内）", async () => {
        await openEditor();
        pointer("pointerDown", 100, 100);
        pointer("pointerMove", -5000, -5000);
        expect([leftOf(), topOf()]).toEqual([0, 0]);
        pointer("pointerMove", 90000, 90000);
        // 右は窓の幅が収まる位置（1700 − 272）、下は見出しが残る位置（高さ − 44）まで
        expect(leftOf()).toBe(window.innerWidth - 272);
        expect(topOf()).toBe(window.innerHeight - 44);
        pointer("pointerUp", 90000, 90000);
      });

      it("「位置をもとに戻す」で既定の場所に戻り、保存も消える", async () => {
        const user = await openEditor();
        expect(screen.queryByRole("button", { name: /センサー棚の位置をもとに戻す/ })).not.toBeInTheDocument();
        handle().focus();
        await user.keyboard("{ArrowRight}");
        await user.click(screen.getByRole("button", { name: /センサー棚の位置をもとに戻す/ }));

        expect(aside().style.left).toBe("8px");
        expect(aside().style.bottom).not.toBe("");
        expect(window.localStorage.getItem("factoreye.sensorShelfPosition")).toBeNull();
        expect(screen.queryByRole("button", { name: /センサー棚の位置をもとに戻す/ })).not.toBeInTheDocument();
      });

      it("次に編集を始めたとき、保存した位置に出る", async () => {
        window.localStorage.setItem("factoreye.sensorShelfPosition", JSON.stringify({ x: 400, y: 220 }));
        await openEditor();
        expect([leftOf(), topOf()]).toEqual([400, 220]);
      });

      it("画面が小さくなって、棚が画面の外になったら、既定の場所に戻す", async () => {
        window.localStorage.setItem("factoreye.sensorShelfPosition", JSON.stringify({ x: 1400, y: 220 }));
        await openEditor();
        expect(leftOf()).toBe(1400);

        Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
        act(() => {
          window.dispatchEvent(new Event("resize"));
        });

        await waitFor(() => expect(aside().style.left).toBe("8px"));
        expect(useEditorStore.getState().shelfPos).toBeNull();
        // 表示だけ既定に戻す。保存した位置は消さない（ズームや回転で一時的に画面が狭くなっただけかもしれない）
        expect(JSON.parse(window.localStorage.getItem("factoreye.sensorShelfPosition")!)).toEqual({ x: 1400, y: 220 });
      });

      it("画面が元の大きさに戻ったあとの編集では、保存した位置が復元される", async () => {
        window.localStorage.setItem("factoreye.sensorShelfPosition", JSON.stringify({ x: 1400, y: 220 }));
        const user = await openEditor();
        Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
        act(() => {
          window.dispatchEvent(new Event("resize"));
        });
        await waitFor(() => expect(aside().style.left).toBe("8px"));

        Object.defineProperty(window, "innerWidth", { value: 1700, configurable: true });
        await user.click(screen.getByRole("button", { name: "編集を終わる" }));
        await user.click(screen.getByRole("button", { name: "✎ 編集する" }));
        await screen.findByRole("complementary", { name: "センサー棚" });

        expect(leftOf()).toBe(1400);
      });

      it("640px 未満に縮めたら、すぐに下寄せの固定に切り替わる", async () => {
        window.localStorage.setItem("factoreye.sensorShelfPosition", JSON.stringify({ x: 400, y: 220 }));
        await openEditor();
        expect(leftOf()).toBe(400);

        Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
        act(() => {
          window.dispatchEvent(new Event("resize"));
        });

        await waitFor(() => expect(aside().style.left).toBe("8px"));
        expect(aside().style.bottom).not.toBe("");
      });

      it("つかんだポインター以外（タッチの 2 本目の指）の動きは無視し、取り消し（pointercancel）でも保存する", async () => {
        await openEditor();
        const send = (type: "pointerDown" | "pointerMove" | "pointerCancel", id: number, x: number, y: number) => {
          const event = createEvent[type](handle());
          Object.defineProperty(event, "pointerId", { value: id });
          Object.defineProperty(event, "clientX", { value: x });
          Object.defineProperty(event, "clientY", { value: y });
          fireEvent(handle(), event);
        };
        // 既定の位置は、時間の操作の実測に依存する（環境で変わる）。動く前の値を読んで、変わらないことを比べる
        const before = [aside().style.left, aside().style.top];
        send("pointerDown", 1, 100, 100);
        send("pointerMove", 2, 400, 400); // 別の指
        expect([aside().style.left, aside().style.top]).toEqual(before); // 別の指では動かない（既定の位置のまま）
        send("pointerMove", 1, 130, 120);
        expect(leftOf()).toBe(30);
        send("pointerCancel", 2, 0, 0); // 別の指の取り消しでは終わらない
        expect(window.localStorage.getItem("factoreye.sensorShelfPosition")).toBeNull();
        send("pointerCancel", 1, 130, 120);
        expect(JSON.parse(window.localStorage.getItem("factoreye.sensorShelfPosition")!)).toEqual({ x: 30, y: 20 });
      });

      it("最初に動かしたとき、棚の高さが急に縮まない（既定の位置の高さ以下）", async () => {
        await openEditor();
        pointer("pointerDown", 100, 100);
        pointer("pointerMove", 100, 100);
        pointer("pointerUp", 100, 100);
        expect(Number.parseInt(aside().style.height, 10)).toBeLessThanOrEqual(window.innerHeight - 164);
        expect(Number.parseInt(aside().style.height, 10)).toBeGreaterThanOrEqual(window.innerHeight - 164 - 8);
      });

      it("localStorage が使えなくても、動かせる（保存されないだけ）", async () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new Error("denied");
        });
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
          throw new Error("denied");
        });
        const user = await openEditor();
        handle().focus();
        await user.keyboard("{ArrowRight}");
        expect(leftOf()).toBeGreaterThan(0);
      });

      it("動かしたあとも、センサーのドラッグ中は棚を隠す仕組みが働く", async () => {
        const user = await openEditor();
        handle().focus();
        await user.keyboard("{ArrowRight}");

        act(() => useEditorStore.getState().setDragging({ kind: "sensor", sensorId: "s1" }));

        await waitFor(() => expect(aside().className).toContain("opacity-0"));
        act(() => useEditorStore.getState().setDragging(null));
        await waitFor(() => expect(aside().className).not.toContain("opacity-0"));
      });

      it("狭い画面（640px 未満）では、保存した位置があっても動かさず、従来の下寄せのまま", async () => {
        Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
        window.localStorage.setItem("factoreye.sensorShelfPosition", JSON.stringify({ x: 100, y: 100 }));
        const user = userEvent.setup();
        vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        // 狭い画面では、棚は閉じて始まる。開く
        await user.click(screen.getByRole("button", { name: "センサー" }));

        expect(aside().style.left).toBe("8px");
        expect(aside().style.bottom).not.toBe("");
        // つかんでも動かない
        pointer("pointerDown", 100, 100);
        pointer("pointerMove", 200, 200);
        expect(aside().style.left).toBe("8px");
      });
    });

    describe("設定パネルも動かせる（センサー棚と同じ仕組み）", () => {
      const panel = () => screen.getByRole("complementary", { name: "設定パネル" });
      const panelHandle = () => screen.getByTestId("panel-handle");
      const leftOf = () => Number.parseInt(panel().style.left, 10);
      const topOf = () => Number.parseInt(panel().style.top, 10);
      const KEY = "factoreye.settingsPanelPosition";

      beforeEach(() => {
        window.localStorage.clear();
        useEditorStore.getState().reset();
      });
      afterEach(() => window.localStorage.clear());

      async function openPanel(widgets = [] as Widget[]) {
        const user = userEvent.setup();
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets });
        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await user.click(screen.getByRole("button", { name: "設定" }));
        return user;
      }

      function pointerOnPanel(type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) {
        const event = createEvent[type](panelHandle());
        Object.defineProperty(event, "clientX", { value: x });
        Object.defineProperty(event, "clientY", { value: y });
        fireEvent(panelHandle(), event);
      }

      it("見出しを矢印キー（Shift で大きく）やドラッグで動かせて、動かし終えたときに保存される", async () => {
        const user = await openPanel();
        expect(panel()).not.toHaveAttribute("data-placement", "moved");
        panelHandle().focus();
        await user.keyboard("{ArrowRight}");
        expect(panel()).toHaveAttribute("data-placement", "moved");
        const x1 = leftOf();
        await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
        expect(leftOf() - x1).toBe(64);

        pointerOnPanel("pointerDown", 100, 100);
        pointerOnPanel("pointerMove", 160, 130);
        const during = JSON.parse(window.localStorage.getItem(KEY)!); // キー操作の保存値のまま（途中は保存しない）
        pointerOnPanel("pointerUp", 160, 130);
        const after = JSON.parse(window.localStorage.getItem(KEY)!);
        expect(after).toEqual({ x: leftOf(), y: topOf() });
        expect(after).not.toEqual(during);
      });

      it("画面内に制限される（見出しは常に画面内）。幅は 316px で数える", async () => {
        await openPanel();
        pointerOnPanel("pointerDown", 100, 100);
        pointerOnPanel("pointerMove", 90000, 90000);
        expect(leftOf()).toBe(window.innerWidth - 316);
        expect(topOf()).toBe(window.innerHeight - 44);
        pointerOnPanel("pointerMove", -90000, -90000);
        expect([leftOf(), topOf()]).toEqual([0, 0]);
        pointerOnPanel("pointerUp", 0, 0);
      });

      it("動かしたあとは、選ぶウィジェットが変わっても、自動配置で位置を変えず、動かした位置を使う", async () => {
        const widgets = [
          makeWidget({ id: "a", type: "AlarmAlert", gridColumn: 1, gridWidth: 4 }),
          makeWidget({ id: "b", type: "AlarmAlert", gridColumn: 9, gridWidth: 4 }),
        ];
        const user = await openPanel(widgets);
        panelHandle().focus();
        await user.keyboard("{ArrowRight}");
        const pos = [panel().style.left, panel().style.top];

        const cards = await screen.findAllByRole("group", { name: "アラーム一覧" });
        await user.click(cards.find((c) => c.dataset.widgetId === "a")!);
        expect(panel()).toHaveAttribute("data-placement", "moved");
        expect([panel().style.left, panel().style.top]).toEqual(pos);
        await user.click(cards.find((c) => c.dataset.widgetId === "b")!);
        expect([panel().style.left, panel().style.top]).toEqual(pos);
      });

      it("「もとの位置」で自動配置に戻り、保存も消える", async () => {
        const user = await openPanel();
        expect(screen.queryByRole("button", { name: /設定パネルの位置をもとに戻す/ })).not.toBeInTheDocument();
        panelHandle().focus();
        await user.keyboard("{ArrowRight}");
        await user.click(screen.getByRole("button", { name: /設定パネルの位置をもとに戻す/ }));

        expect(panel()).not.toHaveAttribute("data-placement", "moved");
        expect(window.localStorage.getItem(KEY)).toBeNull();
      });

      it("次に編集を始めたとき、保存した位置に出る。棚とは別々に保存される", async () => {
        window.localStorage.setItem(KEY, JSON.stringify({ x: 300, y: 200 }));
        await openPanel();
        expect([leftOf(), topOf()]).toEqual([300, 200]);
        expect(useEditorStore.getState().shelfPos).toBeNull();
      });

      it("画面が小さくなって画面外になったら、表示だけ自動配置に戻し、保存は残す", async () => {
        window.localStorage.setItem(KEY, JSON.stringify({ x: 1300, y: 200 }));
        await openPanel();
        expect(leftOf()).toBe(1300);

        Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
        act(() => {
          window.dispatchEvent(new Event("resize"));
        });

        await waitFor(() => expect(panel()).not.toHaveAttribute("data-placement", "moved"));
        expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ x: 1300, y: 200 });
      });

      it("640px 未満では、保存した位置があっても動かさず、従来の下寄せのまま", async () => {
        Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
        window.localStorage.setItem(KEY, JSON.stringify({ x: 100, y: 100 }));
        await openPanel();

        expect(panel()).toHaveAttribute("data-placement", "bottom");
        pointerOnPanel("pointerDown", 100, 100);
        pointerOnPanel("pointerMove", 200, 200);
        expect(panel()).toHaveAttribute("data-placement", "bottom");
      });

      it("動かした位置のパネルでも、パネル内の枠にセンサーをドラッグして置ける", async () => {
        const graph = makeWidget({ id: "g1", type: "SensorGraph", sensorId: "s1", config: { graphType: "line" } });
        vi.mocked(api.updateWidget).mockResolvedValue(graph);
        vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });
        const user = await openPanel([graph]);
        await user.click(await screen.findByRole("group", { name: "グラフ" }));
        panelHandle().focus();
        await user.keyboard("{ArrowRight}");
        expect(panel()).toHaveAttribute("data-placement", "moved");

        act(() => useEditorStore.getState().setDragging({ kind: "sensor", sensorId: "s2" }));
        await waitFor(() => expect(screen.getByRole("complementary", { name: "センサー棚" }).className).toContain("opacity-0"));
        expect(panel().className).not.toContain("opacity-0");
        fireEvent.dragOver(screen.getByTestId("sensor-dropzone"), { dataTransfer: { dropEffect: "none" } });
        fireEvent.drop(screen.getByTestId("sensor-dropzone"), { dataTransfer: { dropEffect: "none" } });

        await waitFor(() =>
          expect(api.updateWidget).toHaveBeenCalledWith("g1", expect.objectContaining({ config: expect.objectContaining({ sensorIds: ["s1", "s2"] }) })),
        );
      });
    });

    it("確認ダイアログの表示中は、Ctrl+Z を画面の裏の元に戻すに効かせない", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(screen.getByRole("button", { name: "設定" }));
      act(() => useEditorStore.getState().pushHistory([]));
      await user.click(screen.getByRole("button", { name: "このダッシュボードを削除" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      await user.keyboard("{Control>}z{/Control}");

      expect(useEditorStore.getState().history).toHaveLength(1);
    });

    it("日本語入力の変換を確定する Enter では、名前を保存しない（確定後の Enter で保存する）", async () => {
      const user = userEvent.setup();
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
      vi.mocked(api.updateDashboard).mockResolvedValue({ ...emptyDashboard, name: "あ" });

      renderWithQueryClient(<DashboardView dashboardId="d1" />);
      await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
      await user.click(screen.getByRole("button", { name: "設定" }));
      const input = screen.getByRole("textbox", { name: "名前" });
      fireEvent.change(input, { target: { value: "あ" } });

      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
      expect(api.updateDashboard).not.toHaveBeenCalled();

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(api.updateDashboard).toHaveBeenCalledWith("d1", expect.objectContaining({ name: "あ" })));
    });

    it("新しく作った直後（編集モードで開く）は、設定パネルの名前の入力欄にフォーカスする", async () => {
      vi.mocked(api.fetchDashboard).mockResolvedValue(emptyDashboard);
      useUiStore.setState({ selectedDashboardId: "d1", openInEditMode: true });

      renderWithQueryClient(<DashboardView dashboardId="d1" />);

      const input = await screen.findByRole("textbox", { name: "名前" });
      await waitFor(() => expect(input).toHaveFocus());
      useUiStore.setState({ openInEditMode: false });
    });

    describe("ドラッグ＆ドロップ", () => {
      // jsdom には寸法が無いので、格子の幅を作る
      beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1224);
      });

      it("空きにセンサーをドロップすると、ドロップした位置にウィジェットを作る", async () => {
        const user = userEvent.setup();
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [makeWidget({ gridWidth: 4, gridHeight: 4 })] });
        vi.mocked(api.addWidget).mockResolvedValue(makeWidget({ id: "w9" }));
        vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await screen.findByText("乾燥炉 温度");
        const surface = screen.getByRole("group", { name: "アラーム一覧" }).closest(".layout")!.parentElement!;

        useEditorStore.getState().setDragging({ kind: "sensor", sensorId: "s1" });
        // 右の列（x=800px あたり）・上から 3 行目（y≒120px）
        sendDrag("dragOver", surface, 800, 120);
        expect(screen.getByText("ここに置く")).toBeInTheDocument();
        sendDrag("drop", surface, 800, 120);

        await waitFor(() => expect(api.addWidget).toHaveBeenCalled());
        const sent = vi.mocked(api.addWidget).mock.calls[0][1];
        expect(sent).toMatchObject({ type: "SensorGraph", sensorId: "s1", gridWidth: 6, gridHeight: 7 });
        // 左のアラーム一覧（1〜4 列）と重ならない
        expect(sent.gridColumn).toBeGreaterThanOrEqual(5);
        expect(useEditorStore.getState().dragging).toBeNull();
      });

      it("グラフの上にセンサーをドロップすると、そのグラフに線を追加する", async () => {
        const user = userEvent.setup();
        const graph = makeWidget({ id: "g1", type: "SensorGraph", sensorId: "s1", config: { graphType: "line" } });
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [graph] });
        vi.mocked(api.updateWidget).mockResolvedValue(graph);
        vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await screen.findByText("ライン1 生産数");
        const card = screen.getByRole("group", { name: "グラフ" });

        useEditorStore.getState().setDragging({ kind: "sensor", sensorId: "s2" });
        sendDrag("dragOver", card, 100, 100);
        expect(screen.getByText("このグラフに追加（Shift で入れ替え）")).toBeInTheDocument();
        sendDrag("drop", card, 100, 100);

        await waitFor(() =>
          expect(api.updateWidget).toHaveBeenCalledWith(
            "g1",
            expect.objectContaining({ config: expect.objectContaining({ sensorIds: ["s1", "s2"] }) }),
          ),
        );
      });

      it("アラーム一覧の上にはセンサーを置けない（点線を出さない）", async () => {
        const user = userEvent.setup();
        vi.mocked(api.fetchDashboard).mockResolvedValue({ ...emptyDashboard, widgets: [makeWidget()] });

        renderWithQueryClient(<DashboardView dashboardId="d1" />);
        await user.click(await screen.findByRole("button", { name: "✎ 編集する" }));
        await screen.findByText("乾燥炉 温度");

        useEditorStore.getState().setDragging({ kind: "sensor", sensorId: "s1" });
        sendDrag("dragOver", screen.getByRole("group", { name: "アラーム一覧" }), 10, 10);

        expect(screen.queryByText("ここに置く")).not.toBeInTheDocument();
        expect(screen.queryByText(/このウィジェットに切り替え/)).not.toBeInTheDocument();
      });
    });
  });
});
