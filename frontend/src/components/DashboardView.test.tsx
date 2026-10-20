import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, createEvent, fireEvent, renderWithQueryClient, screen, waitFor, within } from "../test/test-utils";
import { useEditorStore } from "../store/useEditorStore";
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

      await user.click(screen.getByRole("button", { name: "＋ ウィジェット" }));
      expect(screen.getByRole("group", { name: "ウィジェットの種類" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "設定" }));
      expect(screen.getByRole("complementary", { name: "設定パネル" })).toBeInTheDocument();
      expect(screen.getByText("ダッシュボードの設定")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "センサー棚を閉じる" }));
      expect(screen.queryByRole("complementary", { name: "センサー棚" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "設定パネルを閉じる" }));
      expect(screen.queryByRole("complementary", { name: "設定パネル" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "✓ 編集を終わる" }));
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
      await user.click(screen.getByRole("button", { name: "＋ ウィジェット" }));
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
      expect(await screen.findByRole("button", { name: "元に戻す" })).toBeInTheDocument();

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

      expect(screen.getByRole("button", { name: "↶ 元に戻す" })).toBeDisabled();
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
      function mockWidgetRects(rects: Record<string, [number, number]>) {
        Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
          const range = rects[this.dataset.widgetId ?? ""];
          if (!range) return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
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
