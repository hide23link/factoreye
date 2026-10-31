/**
 * ダッシュボード編集の操作（追加・センサーの割り当て・設定の変更・複製・削除・移動・元に戻す）。
 *
 * 共通の流れ:
 * 1. 操作は、1 つずつ順番に実行する（直列化）。連打や、設定の連続変更が競合して古い値で上書きしないように、
 *    各操作は実行の直前に、キャッシュの最新のウィジェットを読んで内容を決める
 * 2. 変わる内容がなければ何もしない（履歴にも積まない）
 * 3. 操作の直前のウィジェット一覧を、元に戻す履歴に記録する
 * 4. 画面のキャッシュを先に書き換える（変更がすぐ見える。保存ボタンは無い）
 * 5. サーバーに保存する。失敗したら通知を出し、その操作の履歴だけを捨てる
 * 6. 待っている操作が全部終わったら、1 回だけサーバーの状態を取り直す（途中の取り直しでちらつかないように）
 *
 * 【誰が使うか】DashboardView、WidgetCard、EditorShelf、SettingsPanel、DropSurface。
 * 【引数】dashboard = 編集中のダッシュボード（最新の状態は、画面のキャッシュから読む）。
 */
import { useQueryClient } from "@tanstack/react-query";

import { addWidget, deleteWidget, updateWidget } from "../lib/api";
import { describeActionError } from "../lib/errors";
import { graphSensorPatch } from "../lib/graph-config";
import { bottomRow, findFreeSpot } from "../lib/grid-placement";
import { pendingSaves } from "../lib/pending-saves";
import { guessSensorKind } from "../lib/sensor-kind";
import { defaultWidgetFor, widgetKind, widgetLabel } from "../lib/widget-catalog";
import { assignSensor, type AssignMode } from "../lib/widget-sensors";
import { planRestore } from "../lib/widget-snapshot";
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

// 操作の待ち行列。ダッシュボードをまたいで 1 本（編集画面は同時に 1 つしか開かないため）。
// 各操作は自分でエラーを処理するので、この Promise は失敗しない
let queue: Promise<void> = Promise.resolve();

/** undefined の項目を取り除く（JSON にしたとき消える項目を、キャッシュの上でも消す） */
function withoutUndefined(config: WidgetConfig): WidgetConfig {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

const sameContent = (a: Widget, b: Widget) =>
  a.sensorId === b.sensorId && JSON.stringify(a.config) === JSON.stringify(b.config);

/**
 * 一括追加の結果。added = 追加できたセンサー、failed = できなかったセンサー、
 * graphed = added のうち、グラフにまとめたセンサー、graphCount = 作ったグラフの数。
 */
export interface AddSensorsResult {
  added: Sensor[];
  failed: Sensor[];
  graphed: Sensor[];
  graphCount: number;
}

/** 一括追加で、1 つのグラフに載せるセンサーの数の上限の既定。これを超えると読みにくいので、呼ぶ側が確認する */
export const GRAPH_SENSOR_LIMIT = 12;

/** 配列を size 個ずつに分ける */
function chunked<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

export function useWidgetActions(dashboard: DashboardDetail) {
  const queryClient = useQueryClient();
  const queryKey = ["dashboard", dashboard.id];

  const currentWidgets = (): Widget[] =>
    queryClient.getQueryData<DashboardDetail>(queryKey)?.widgets ?? dashboard.widgets;

  /** 操作を待ち行列に入れる。待ちが全部終わったら、サーバーの状態を 1 回だけ取り直す */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    pendingSaves.start();
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      if (pendingSaves.finish()) void queryClient.invalidateQueries({ queryKey });
    });
  };

  // 取得中の古い応答が、先に書き換えたキャッシュを上書きしないよう、取得を止めてから書き換える
  const writeCache = async (change: (widgets: Widget[]) => Widget[]) => {
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<DashboardDetail>(queryKey, (old) =>
      old ? { ...old, widgets: change(old.widgets) } : old,
    );
  };

  /** 失敗したら通知を出して false を返す */
  const attempt = async (actionName: string, task: () => Promise<void>): Promise<boolean> => {
    try {
      await task();
      return true;
    } catch (error) {
      useEditorStore.getState().showToast(describeActionError(error, actionName));
      return false;
    }
  };

  /** 操作の直前の一覧を履歴に積み、その記録を返す（失敗したら、この記録だけを捨てる） */
  const remember = (): Widget[] => {
    const snapshot = currentWidgets();
    useEditorStore.getState().pushHistory(snapshot);
    return snapshot;
  };
  const forget = (snapshot: Widget[]) => useEditorStore.getState().discardHistory(snapshot);

  // ---- 待ち行列の中で実行する本体（enqueue の中からだけ呼ぶ。中で enqueue すると、自分の完了を待って止まる）----

  const doUndo = async () => {
    const store = useEditorStore.getState();
    const snapshot = store.popHistory();
    if (!snapshot) {
      store.showToast("元に戻す操作はありません");
      return;
    }
    const current = currentWidgets();
    const plan = planRestore(current, snapshot);
    if (plan.deleteIds.length + plan.recreate.length + plan.update.length === 0) return;

    await writeCache(() => snapshot);
    const created = new Map<string, Widget>();
    const ok = await attempt("元に戻す操作", async () => {
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
        ...plan.recreate.map(async (w) => {
          created.set(
            w.id,
            await addWidget(dashboard.id, {
              type: w.type,
              sensorId: w.sensorId,
              gridColumn: w.gridColumn,
              gridRow: w.gridRow,
              gridWidth: w.gridWidth,
              gridHeight: w.gridHeight,
              config: w.config,
            }),
          );
        }),
      ]);
    });
    if (!ok) {
      // 戻せなかった記録は残す（もう一度押せるように）
      useEditorStore.getState().pushHistory(snapshot);
      return;
    }
    // 作り直したウィジェットは ID が新しくなる。次の操作が古い ID を使わないよう、キャッシュに反映する
    await writeCache(() => snapshot.map((w) => created.get(w.id) ?? w));
    const selected = useEditorStore.getState().selectedWidgetId;
    if (selected && (created.has(selected) || !snapshot.some((w) => w.id === selected))) {
      useEditorStore.getState().select(null);
    }
  };

  /** 新しく置く。置いたものを選択状態にして返す。失敗したら null */
  const doCreate = async (
    type: WidgetType,
    options: { sensorId?: string | null; config?: WidgetConfig; position?: { column: number; row: number } } = {},
  ): Promise<Widget | null> => {
    const kind = widgetKind(type);
    if (!kind) return null;
    const widgets = currentWidgets();
    const want = options.position ?? { column: 1, row: bottomRow(widgets) };
    const spot = findFreeSpot(widgets, kind.width, kind.height, want.column, want.row);
    const snapshot = remember();
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
    const widget = made.widget;
    if (!widget) {
      forget(snapshot);
      return null;
    }
    await writeCache((all) => [...all, widget]);
    useEditorStore.getState().select(widget.id);
    return widget;
  };

  /** 設定・センサーの変更を、最新のウィジェットに適用して保存する。変わらなければ何もしない */
  const doPatch = async (widgetId: string, build: (latest: Widget) => WidgetPatch | null): Promise<boolean> => {
    const latest = currentWidgets().find((w) => w.id === widgetId);
    if (!latest) return false;
    const change = build(latest);
    if (!change) return false;
    const next: Widget = {
      ...latest,
      sensorId: change.sensorId === undefined ? latest.sensorId : change.sensorId,
      config: change.config ? withoutUndefined(change.config) : latest.config,
    };
    if (sameContent(latest, next)) return false;
    const snapshot = remember();
    await writeCache((widgets) => widgets.map((w) => (w.id === widgetId ? next : w)));
    const ok = await attempt("ウィジェットの保存", async () => {
      await updateWidget(widgetId, { sensorId: next.sensorId, config: next.config });
    });
    if (!ok) forget(snapshot);
    return ok;
  };

  const doAssign = async (widgetId: string, sensor: Sensor, mode: AssignMode) => {
    const latest = currentWidgets().find((w) => w.id === widgetId);
    if (!latest) return;
    const result = assignSensor(latest, sensor, mode);
    if (!result.ok) {
      useEditorStore.getState().showToast(result.message);
      return;
    }
    const ok = await doPatch(widgetId, () => ({ sensorId: result.sensorId, config: result.config }));
    if (!ok) return;
    useEditorStore.getState().select(widgetId);
    useEditorStore.getState().showToast(result.message);
  };

  /** 種類を変える。先に新しいウィジェットを作り、できてから古いものを消す（作れなかったときに、元のものが消えないように） */
  const doChangeType = async (widgetId: string, type: WidgetType) => {
    const kind = widgetKind(type);
    const old = currentWidgets().find((w) => w.id === widgetId);
    if (!kind || !old) return;
    const spot = findFreeSpot(
      currentWidgets().filter((w) => w.id !== old.id),
      kind.width,
      kind.height,
      old.gridColumn,
      old.gridRow,
    );
    const snapshot = remember();
    const made: { widget: Widget | null } = { widget: null };
    const added = await attempt("ウィジェットの種類の変更", async () => {
      made.widget = await addWidget(dashboard.id, {
        type,
        sensorId: old.sensorId,
        gridColumn: spot.column,
        gridRow: spot.row,
        gridWidth: spot.width,
        gridHeight: spot.height,
        config: kind.defaultConfig,
      });
    });
    const widget = made.widget;
    if (!added || !widget) {
      forget(snapshot);
      return;
    }
    await writeCache((all) => [...all, widget]);
    useEditorStore.getState().select(widget.id);
    const removed = await attempt("元のウィジェットの削除", async () => {
      await deleteWidget(old.id);
    });
    if (removed) await writeCache((all) => all.filter((w) => w.id !== old.id));
  };

  const doRemove = async (widgetId: string) => {
    const widget = currentWidgets().find((w) => w.id === widgetId);
    if (!widget) return;
    const snapshot = remember();
    await writeCache((widgets) => widgets.filter((w) => w.id !== widgetId));
    if (useEditorStore.getState().selectedWidgetId === widgetId) useEditorStore.getState().select(null);
    const ok = await attempt("ウィジェットの削除", async () => {
      await deleteWidget(widgetId);
    });
    if (!ok) {
      forget(snapshot);
      return;
    }
    // 通知の「元に戻す」は、押した時点の最新の操作ではなく、この削除だけを取り消す（その後の操作は巻き込まない）
    useEditorStore.getState().showToast("削除しました", {
      label: "元に戻す",
      run: () => void restoreDeleted(widget, snapshot),
    });
  };

  // ---- 外へ出す操作（待ち行列に入れる）----

  /** 削除したウィジェットだけを、同じ設定で作り直す。その削除の履歴は捨てる */
  const restoreDeleted = (widget: Widget, snapshot: Widget[]) =>
    enqueue(async () => {
      forget(snapshot);
      const spot = findFreeSpot(currentWidgets(), widget.gridWidth, widget.gridHeight, widget.gridColumn, widget.gridRow);
      const made: { widget: Widget | null } = { widget: null };
      await attempt("元に戻す操作", async () => {
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
      const restored = made.widget;
      if (!restored) return;
      await writeCache((all) => [...all, restored]);
      useEditorStore.getState().select(restored.id);
    });

  const undo = () => enqueue(doUndo);

  /** 棚のウィジェットの種類から追加する（クリック・ドロップ） */
  const addByType = (type: WidgetType, position?: { column: number; row: number }) =>
    enqueue(async () => {
      const created = await doCreate(type, { position });
      if (created) useEditorStore.getState().showToast(`${widgetLabel(type)}を追加しました。右の設定で内容を決めます`);
    });

  const patch = (widget: Widget, change: WidgetPatch) => enqueue(() => doPatch(widget.id, () => change));

  /** 設定の一部だけを変える（最新の設定に重ねる）。undefined を渡した項目は「未指定」に戻す */
  const patchConfig = (widget: Widget, change: Partial<WidgetConfig>) =>
    enqueue(() => doPatch(widget.id, (latest) => ({ config: { ...latest.config, ...change } })));

  /** 最新のウィジェットから変更内容を作る（色の切り替え・センサーを外すなど、今の値に依る変更） */
  const patchFromLatest = (widget: Widget, build: (latest: Widget) => WidgetPatch | null) =>
    enqueue(() => doPatch(widget.id, build));

  /** センサーをウィジェットに割り当てる（ドロップ・設定パネル）。結果を通知に出す */
  const assign = (widget: Widget, sensor: Sensor, mode: AssignMode) => enqueue(() => doAssign(widget.id, sensor, mode));

  /**
   * センサーの「＋」ボタン・空きへのドロップ。
   * 選択中のグラフがあれば（稼働以外のセンサーなら）そこへ追加し、無ければ種類に合うウィジェットを新しく作る。
   * chosenType を渡したときは（置き方の選択）、その種類のウィジェットを新しく作る。
   */
  const addSensor = (sensor: Sensor, position?: { column: number; row: number }, chosenType?: WidgetType) =>
    enqueue(async () => {
      // 置き方を選んだとき（センサー棚の「📈 グラフ」など）は、その種類で新しく作る
      if (chosenType) {
        const made = await doCreate(chosenType, { sensorId: sensor.id, position });
        if (made) useEditorStore.getState().showToast(`「${sensor.name}」を${widgetLabel(chosenType)}として追加しました`);
        return;
      }
      const selectedId = useEditorStore.getState().selectedWidgetId;
      const selected = currentWidgets().find((w) => w.id === selectedId);
      const kind = guessSensorKind(sensor);
      const isGraph = selected?.type === "SensorGraph" || selected?.type === "MultiSensorComparison";
      if (!position && selected && isGraph && kind !== "state") {
        await doAssign(selected.id, sensor, "add");
        return;
      }
      const type = defaultWidgetFor(kind);
      const created = await doCreate(type, { sensorId: sensor.id, position });
      if (!created) return;
      // 推測が外れたときに、すぐ作り替えられるようにする（グラフ↔数値、生産管理・稼働ステータス→グラフ）
      const alternative: { label: string; to: WidgetType } =
        type === "SensorGraph" ? { label: "数値にする", to: "StatValue" } : { label: "グラフにする", to: "SensorGraph" };
      useEditorStore.getState().showToast(`「${sensor.name}」を${widgetLabel(type)}として追加しました`, {
        label: alternative.label,
        run: () => void changeType(created, alternative.to),
      });
    });

  /**
   * 複数のセンサーを追加する（センサー棚の一括追加）。選択中のウィジェットには重ねない。
   * - 計測値のセンサーは、新しいグラフ 1 つにまとめる（graphLimit 個を超えるときは、その数ずつ複数のグラフに分ける）。
   *   単位が複数あるとき（電圧 V と電流 A など）は、縦軸をセンサーごとの 0〜100% にそろえる（実際の値だと、小さいほうが潰れて読めないため）
   * - 生産数・稼働のセンサーは、グラフに載せるのが不自然なので、これまでどおり種類に合う既定のウィジェットを 1 つずつ作る
   * 1 つ失敗しても続け、追加できたセンサーとできなかったセンサーを返す（グラフが作れなければ、そのグラフの全センサーが失敗）。
   * 元に戻す履歴は、ウィジェット 1 つにつき 1 回分。
   */
  const addSensors = (sensors: Sensor[], options: { graphLimit?: number } = {}): Promise<AddSensorsResult> =>
    enqueue(async () => {
      const result: AddSensorsResult = { added: [], failed: [], graphed: [], graphCount: 0 };
      const measures = sensors.filter((s) => guessSensorKind(s) === "measure");
      const others = sensors.filter((s) => guessSensorKind(s) !== "measure");
      const graphConfigBase = widgetKind("SensorGraph")?.defaultConfig ?? {};

      for (const batch of chunked(measures, options.graphLimit ?? Number.POSITIVE_INFINITY)) {
        const patch = graphSensorPatch({ type: "SensorGraph", config: graphConfigBase }, batch.map((s) => s.id), []);
        const units = new Set(batch.map((s) => s.unit.trim()));
        const config = units.size > 1 ? { ...patch.config, axisMode: "normalized" as const } : patch.config;
        const created = await doCreate("SensorGraph", { sensorId: patch.sensorId, config });
        if (!created) {
          result.failed.push(...batch);
          continue;
        }
        result.added.push(...batch);
        result.graphed.push(...batch);
        result.graphCount += 1;
      }
      for (const sensor of others) {
        const created = await doCreate(defaultWidgetFor(guessSensorKind(sensor)), { sensorId: sensor.id });
        (created ? result.added : result.failed).push(sensor);
      }
      return result;
    });

  const changeType = (widget: Widget, type: WidgetType) => enqueue(() => doChangeType(widget.id, type));

  const duplicate = (widget: Widget) =>
    enqueue(async () => {
      const latest = currentWidgets().find((w) => w.id === widget.id) ?? widget;
      const spot = findFreeSpot(currentWidgets(), latest.gridWidth, latest.gridHeight, latest.gridColumn, latest.gridRow + latest.gridHeight);
      const snapshot = remember();
      const made: { widget: Widget | null } = { widget: null };
      await attempt("ウィジェットの複製", async () => {
        made.widget = await addWidget(dashboard.id, {
          type: latest.type,
          sensorId: latest.sensorId,
          gridColumn: spot.column,
          gridRow: spot.row,
          gridWidth: spot.width,
          gridHeight: spot.height,
          config: latest.config,
        });
      });
      const copy = made.widget;
      if (!copy) {
        forget(snapshot);
        return;
      }
      await writeCache((all) => [...all, copy]);
      useEditorStore.getState().select(copy.id);
    });

  const remove = (widget: Widget) => enqueue(() => doRemove(widget.id));

  /** 移動・大きさの変更を保存する。変わったウィジェットだけを更新する */
  const saveLayout = (layout: readonly LayoutItem[]) =>
    enqueue(async () => {
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
      const snapshot = remember();
      await writeCache((all) => all.map((w) => ({ ...w, ...(changes.find((c) => c.widget.id === w.id)?.next ?? {}) })));
      const ok = await attempt("ウィジェットの移動", async () => {
        await Promise.all(changes.map((c) => updateWidget(c.widget.id, c.next)));
      });
      if (!ok) forget(snapshot);
    });

  return { addByType, addSensor, addSensors, assign, patch, patchConfig, patchFromLatest, duplicate, remove, saveLayout, undo, changeType };
}
