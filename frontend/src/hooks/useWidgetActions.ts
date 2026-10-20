/**
 * ダッシュボード編集の操作（追加・センサーの割り当て・設定の変更・複製・削除・移動・元に戻す）。
 *
 * 共通の流れ:
 * 1. 操作の直前のウィジェット一覧を、元に戻す履歴に記録する
 * 2. 画面のキャッシュを先に書き換える（変更がすぐ見える。保存ボタンは無い）
 * 3. サーバーに保存し、終わったら取り直す（失敗したら通知を出し、取り直して元の表示に戻す）
 *
 * 【誰が使うか】DashboardView、WidgetCard、EditorShelf、SettingsPanel。
 * 【引数】dashboard = 編集中のダッシュボード（最新の状態は、画面のキャッシュから読む）。
 */
import { useQueryClient } from "@tanstack/react-query";

import { addWidget, deleteWidget, updateWidget } from "../lib/api";
import { describeActionError } from "../lib/errors";
import { bottomRow, findFreeSpot, type GridRect } from "../lib/grid-placement";
import { defaultWidgetFor, widgetKind, widgetLabel } from "../lib/widget-catalog";
import { guessSensorKind } from "../lib/sensor-kind";
import { planRestore } from "../lib/widget-snapshot";
import { assignSensor, type AssignMode } from "../lib/widget-sensors";
import { useEditorStore } from "../store/useEditorStore";
import type { DashboardDetail, Sensor, Widget, WidgetConfig, WidgetType } from "../types";

/** react-grid-layout の1項目（0 始まり）。DashboardView が渡す */
export interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 設定パネルからの変更。センサーを変えるときだけ sensorId を渡す */
export interface WidgetPatch {
  sensorId?: string | null;
  config?: WidgetConfig;
}

export function useWidgetActions(dashboard: DashboardDetail) {
  const queryClient = useQueryClient();
  const queryKey = ["dashboard", dashboard.id];

  const currentWidgets = (): Widget[] =>
    queryClient.getQueryData<DashboardDetail>(queryKey)?.widgets ?? dashboard.widgets;

  const refresh = () => queryClient.invalidateQueries({ queryKey });

  // 取得中の古い応答が、先に書き換えたキャッシュを上書きしないよう、取得を止めてから書き換える
  const writeCache = async (change: (widgets: Widget[]) => Widget[]) => {
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<DashboardDetail>(queryKey, (old) =>
      old ? { ...old, widgets: change(old.widgets) } : old,
    );
  };

  /** 失敗したら通知を出し、いずれにせよサーバーの状態を取り直す（キャッシュの先読みを正す） */
  const attempt = async (actionName: string, task: () => Promise<void>): Promise<boolean> => {
    try {
      await task();
      return true;
    } catch (error) {
      useEditorStore.getState().showToast(describeActionError(error, actionName));
      return false;
    } finally {
      void refresh();
    }
  };

  const remember = () => useEditorStore.getState().pushHistory(currentWidgets());

  /** 元に戻す。履歴の記録と今の状態の差分をサーバーに反映する */
  const undo = async () => {
    const store = useEditorStore.getState();
    const snapshot = store.popHistory();
    if (!snapshot) {
      store.showToast("元に戻す操作はありません");
      return;
    }
    const plan = planRestore(currentWidgets(), snapshot);
    await writeCache(() => snapshot);
    await attempt("元に戻す操作", async () => {
      await Promise.all([
        ...plan.deleteIds.map((id) => deleteWidget(id)),
        ...plan.update.map((w) =>
          updateWidget(w.id, {
            sensorId: w.sensorId,
            gridColumn: w.gridColumn,
            gridRow: w.gridRow,
            gridWidth: w.gridWidth,
            gridHeight: w.gridHeight,
            config: w.config,
          }),
        ),
        ...plan.recreate.map((w) =>
          addWidget(dashboard.id, {
            type: w.type,
            sensorId: w.sensorId,
            gridColumn: w.gridColumn,
            gridRow: w.gridRow,
            gridWidth: w.gridWidth,
            gridHeight: w.gridHeight,
            config: w.config,
          }),
        ),
      ]);
    });
    const stillThere = new Set(snapshot.map((w) => w.id));
    const selected = useEditorStore.getState().selectedWidgetId;
    // 作り直したウィジェットは ID が変わるため、消えた選択は外す
    if (selected && (!stillThere.has(selected) || plan.recreate.some((w) => w.id === selected))) {
      useEditorStore.getState().select(null);
    }
  };

  /** ウィジェットを新しく置く。position が無ければ一番下。置いたものを選択状態にする */
  const create = async (
    type: WidgetType,
    options: { sensorId?: string | null; config?: WidgetConfig; position?: { column: number; row: number } } = {},
  ): Promise<Widget | null> => {
    const kind = widgetKind(type);
    if (!kind) return null;
    const widgets = currentWidgets();
    const want = options.position ?? { column: 1, row: bottomRow(widgets) };
    const spot = findFreeSpot(widgets, kind.width, kind.height, want.column, want.row);
    remember();
    // 非同期の中で代入するため、TypeScript が代入を追えるよう、入れ物（オブジェクト）で受ける
    const made: { widget: Widget | null } = { widget: null };
    await attempt("ウィジェットの追加", async () => {
      made.widget = await addWidget(dashboard.id, {
        type,
        sensorId: options.sensorId ?? null,
        gridColumn: spot.column,
        gridRow: spot.row,
        gridWidth: spot.width,
        gridHeight: spot.height,
        config: options.config ?? kind.defaultConfig,
      });
    });
    if (made.widget) useEditorStore.getState().select(made.widget.id);
    else useEditorStore.getState().popHistory();
    return made.widget;
  };

  /** 棚のウィジェットの種類から追加する（クリック・ドロップ） */
  const addByType = async (type: WidgetType, position?: { column: number; row: number }) => {
    const created = await create(type, { position });
    if (created) useEditorStore.getState().showToast(`${widgetLabel(type)}を追加しました。右の設定で内容を決めます`);
  };

  /** 設定の変更（即時に反映して保存する） */
  const patch = async (widget: Widget, change: WidgetPatch) => {
    const next: Widget = {
      ...widget,
      sensorId: change.sensorId === undefined ? widget.sensorId : change.sensorId,
      config: change.config ?? widget.config,
    };
    remember();
    await writeCache((widgets) => widgets.map((w) => (w.id === widget.id ? next : w)));
    const ok = await attempt("ウィジェットの保存", async () => {
      await updateWidget(widget.id, { sensorId: next.sensorId, config: next.config });
    });
    if (!ok) useEditorStore.getState().popHistory();
  };

  /** センサーをウィジェットに割り当てる（ドロップ・設定パネル）。結果を通知に出す */
  const assign = async (widget: Widget, sensor: Sensor, mode: AssignMode) => {
    const result = assignSensor(widget, sensor, mode);
    if (!result.ok) {
      useEditorStore.getState().showToast(result.message);
      return;
    }
    await patch(widget, { sensorId: result.sensorId, config: result.config });
    useEditorStore.getState().select(widget.id);
    useEditorStore.getState().showToast(result.message);
  };

  /**
   * センサーの「＋」ボタン・空きへのドロップ。
   * 選択中のグラフがあれば（稼働以外のセンサーなら）そこへ追加し、無ければ種類に合うウィジェットを新しく作る。
   */
  const addSensor = async (sensor: Sensor, position?: { column: number; row: number }) => {
    const store = useEditorStore.getState();
    const selected = currentWidgets().find((w) => w.id === store.selectedWidgetId);
    const kind = guessSensorKind(sensor);
    const isGraph = selected?.type === "SensorGraph" || selected?.type === "MultiSensorComparison";
    if (!position && selected && isGraph && kind !== "state") {
      await assign(selected, sensor, "add");
      return;
    }
    const type = defaultWidgetFor(kind);
    const created = await create(type, { sensorId: sensor.id, position });
    if (!created) return;
    const swap = type === "SensorGraph" ? { label: "数値にする", to: "StatValue" as const } : null;
    useEditorStore
      .getState()
      .showToast(`「${sensor.name}」を${widgetLabel(type)}として追加しました`, swap ? { label: swap.label, run: () => void changeType(created, swap.to) } : undefined);
  };

  /** 種類を変える（追加直後の「数値にする」など）。大きさは新しい種類の既定にする */
  const changeType = async (widget: Widget, type: WidgetType) => {
    const kind = widgetKind(type);
    if (!kind) return;
    const others = currentWidgets().filter((w) => w.id !== widget.id);
    const spot = findFreeSpot(others, kind.width, kind.height, widget.gridColumn, widget.gridRow);
    remember();
    // 種類は更新 API で変えられないため、同じ位置に作り直す
    await attempt("ウィジェットの種類の変更", async () => {
      await deleteWidget(widget.id);
      const created = await addWidget(dashboard.id, {
        type,
        sensorId: widget.sensorId,
        gridColumn: spot.column,
        gridRow: spot.row,
        gridWidth: spot.width,
        gridHeight: spot.height,
        config: kind.defaultConfig,
      });
      useEditorStore.getState().select(created.id);
    });
  };

  const duplicate = async (widget: Widget) => {
    const widgets = currentWidgets();
    const spot: GridRect = findFreeSpot(widgets, widget.gridWidth, widget.gridHeight, widget.gridColumn, widget.gridRow + widget.gridHeight);
    remember();
    const made: { widget: Widget | null } = { widget: null };
    await attempt("ウィジェットの複製", async () => {
      made.widget = await addWidget(dashboard.id, {
        type: widget.type,
        sensorId: widget.sensorId,
        gridColumn: spot.column,
        gridRow: spot.row,
        gridWidth: spot.width,
        gridHeight: spot.height,
        config: widget.config,
      });
    });
    if (made.widget) useEditorStore.getState().select(made.widget.id);
    else useEditorStore.getState().popHistory();
  };

  const remove = async (widget: Widget) => {
    remember();
    await writeCache((widgets) => widgets.filter((w) => w.id !== widget.id));
    if (useEditorStore.getState().selectedWidgetId === widget.id) useEditorStore.getState().select(null);
    const ok = await attempt("ウィジェットの削除", async () => {
      await deleteWidget(widget.id);
    });
    if (ok) useEditorStore.getState().showToast("削除しました", { label: "元に戻す", run: () => void undo() });
    else useEditorStore.getState().popHistory();
  };

  /** 移動・大きさの変更を保存する。変わったウィジェットだけを更新する */
  const saveLayout = async (layout: readonly LayoutItem[]) => {
    const widgets = currentWidgets();
    const changes = layout.flatMap((item) => {
      const widget = widgets.find((w) => w.id === item.i);
      if (!widget) return [];
      const next = { gridColumn: item.x + 1, gridRow: item.y + 1, gridWidth: item.w, gridHeight: item.h };
      const changed =
        widget.gridColumn !== next.gridColumn ||
        widget.gridRow !== next.gridRow ||
        widget.gridWidth !== next.gridWidth ||
        widget.gridHeight !== next.gridHeight;
      return changed ? [{ widget, next }] : [];
    });
    if (changes.length === 0) return;
    remember();
    await writeCache((all) => all.map((w) => ({ ...w, ...(changes.find((c) => c.widget.id === w.id)?.next ?? {}) })));
    const ok = await attempt("ウィジェットの移動", async () => {
      await Promise.all(changes.map((c) => updateWidget(c.widget.id, c.next)));
    });
    if (!ok) useEditorStore.getState().popHistory();
  };

  return { addByType, addSensor, assign, patch, duplicate, remove, saveLayout, undo, changeType };
}
