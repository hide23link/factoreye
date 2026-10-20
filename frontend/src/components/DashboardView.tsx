/**
 * ダッシュボードの表示画面。
 * ウィジェットを 12 列の格子（react-grid-layout）に置く。
 *
 * 「編集する」を押すと編集モードになる。閲覧と編集で、ウィジェットの位置・大きさ・ヘッダーの高さが変わらないよう、
 * 格子（キャンバス）は両方のモードで同じ幅・同じ位置にし、編集用の窓はキャンバスの上に重ねて出す（どれも閉じられる）:
 * - 左: センサー棚（ドラッグ、または「＋」で追加）
 * - 上のバー: 「＋ ウィジェット」で種類の部品バーを開く（ドラッグ、またはクリックで追加）
 * - 右: 設定パネル（ウィジェットを選ぶとその設定、未選択ならダッシュボードの名前・説明）
 * ウィジェットは、カードをつかんで移動、右下で大きさを変える。
 * 変更はすぐ保存する。Ctrl/⌘+Z で元に戻す。Delete で選択中のウィジェットを削除（Backspace は誤操作しやすいので使わない）。
 *
 * 【誰が使うか】App.tsx が、ダッシュボードを選んだときに出す。
 * 【引数（props）】dashboardId = 表示するダッシュボードの ID（App.tsx が渡す）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Responsive, WidthProvider } from "react-grid-layout/legacy";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { useDashboard } from "../hooks/queries";
import { useWidgetActions } from "../hooks/useWidgetActions";
import { GRID_MARGIN, GRID_ROW_HEIGHT } from "../lib/grid-placement";
import { choosePanelPlacement, leftPanelOffset, type PanelPlacement } from "../lib/panel-placement";
import { useEditorStore } from "../store/useEditorStore";
import { initTimeRangeFromUrl, resetTimeRange } from "../store/useTimeRangeStore";
import { useUiStore } from "../store/useUiStore";
import type { DashboardDetail, Widget } from "../types";
import { DropSurface } from "./editor/DropSurface";
import { EditorShelf } from "./editor/EditorShelf";
import { EditorToast } from "./editor/EditorToast";
import { WidgetPalette } from "./editor/WidgetPalette";
import { SettingsPanel } from "./editor/SettingsPanel";
import { ErrorNotice } from "./ErrorNotice";
import { TimeRangeControls } from "./TimeRangeControls";
import { WidgetCard } from "./WidgetCard";

// 幅に応じて列数を変える（画面が狭いほど列が少なくなる）。lg は 12 列
const ResponsiveGridLayout = WidthProvider(Responsive);

// react-grid-layout は0始まりのx/y、backendは1始まりのgridColumn/gridRow
const GRID_COLS = { lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 };
const VIEW_BREAKPOINTS = { lg: 1024, md: 768, sm: 576, xs: 400, xxs: 0 };
// 編集中は、棚と設定パネルで格子が狭くなる。列数が変わると置いた位置が崩れるため、常に 12 列で編集する
const EDIT_COLS = { lg: 12 };
const EDIT_BREAKPOINTS = { lg: 0 };

/** ウィジェットを、格子のレイアウト項目に変換する（列・行は 0 始まりに直す）。最小サイズは 1 列・2 行。 */
function toLayoutItem(widget: Widget) {
  return {
    i: widget.id,
    x: widget.gridColumn - 1,
    y: widget.gridRow - 1,
    w: widget.gridWidth,
    h: widget.gridHeight,
    minW: 1,
    minH: 2,
  };
}

/** 入力欄の中では、Delete や Ctrl+Z をウィジェットの操作にしない */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
}

/** ダッシュボードの表示本体。dashboardId のダッシュボードを、取得して描く。 */
export function DashboardView({ dashboardId }: { dashboardId: string }) {
  const { data: dashboard, isLoading, isError, refetch } = useDashboard(dashboardId);
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const editing = useEditorStore((s) => s.editing);

  // 表示時間範囲: 開いたとき URL（あれば）、無ければ最後に見ていた範囲（localStorage）から読み、
  // 閉じたら画面の状態は既定に戻して URL からも消す（localStorage は残す）
  useEffect(() => {
    initTimeRangeFromUrl();
    return () => resetTimeRange();
  }, []);

  // 別のダッシュボードへ移るとき・閉じるときは、編集の状態（履歴・選択）を捨てる。
  // 新しく作った直後は、そのまま編集モードで開く（開発時の StrictMode は、開く→捨てる→開く の順に動くため、
  // 「編集で開く」の指定はここで消さず、開くたびに読む）
  useEffect(() => {
    if (useUiStore.getState().openInEditMode) useEditorStore.getState().startEditing({ focusName: true });
    return () => useEditorStore.getState().reset();
  }, [dashboardId]);

  // 狭い画面（スマホ）では、ウィジェットの並べ替えとサイズ変更を止める（画面のスクロールと干渉するため）
  const [isNarrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 575px)").matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 575px)");
    if (!query) return;
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  if (!dashboard && isError) {
    return (
      <div className="p-4">
        <ErrorNotice message="ダッシュボードを取得できませんでした。" onRetry={() => void refetch()}>
          <button
            type="button"
            onClick={() => selectDashboard(null)}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            ← 一覧へ
          </button>
        </ErrorNotice>
      </div>
    );
  }
  if (isLoading || !dashboard) {
    return <p className="p-4 text-sm text-gray-400">読み込み中...</p>;
  }

  return <LoadedDashboard dashboard={dashboard} isNarrow={isNarrow} editing={editing} />;
}

function LoadedDashboard({
  dashboard,
  isNarrow,
  editing,
}: {
  dashboard: DashboardDetail;
  isNarrow: boolean;
  editing: boolean;
}) {
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const historySize = useEditorStore((s) => s.history.length);
  const actions = useWidgetActions(dashboard);

  // キーボード: Ctrl/⌘+Z で元に戻す、Delete で選択中を削除、Esc で選択を外す
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      // 確認ダイアログの表示中は、キー操作を画面の裏のウィジェットに効かせない（Delete・Ctrl+Z）
      if (document.querySelector('[role="dialog"]')) return;
      const store = useEditorStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void actions.undo();
      } else if (e.key === "Delete" && store.selectedWidgetId) {
        const widget = dashboard.widgets.find((w) => w.id === store.selectedWidgetId);
        if (widget) {
          e.preventDefault();
          void actions.remove(widget);
        }
      } else if (e.key === "Escape") {
        store.select(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const layout = dashboard.widgets.map(toLayoutItem);
  // 閲覧と編集で、同じ幅・同じ列数にする（幅 768px 以上は 12 列で同じ）。
  // 768px 未満では、閲覧は列を減らして詰め直すが、編集は位置が崩れないよう常に 12 列で扱う（保存する位置は 12 列の値のため）
  const gridProps = editing
    ? { layouts: { lg: layout }, breakpoints: EDIT_BREAKPOINTS, cols: EDIT_COLS }
    : {
        layouts: { lg: layout, md: layout, sm: layout, xs: layout, xxs: layout },
        breakpoints: VIEW_BREAKPOINTS,
        cols: GRID_COLS,
      };

  const grid = isNarrow ? (
    // スマホ: 格子をやめて、ウィジェットを縦 1 列に並べる（各ウィジェットに十分な高さを与える）
    <div className="flex flex-col gap-3">
      {dashboard.widgets.map((widget) => (
        <div key={widget.id} className="h-80">
          <WidgetCard widget={widget} dashboard={dashboard} />
        </div>
      ))}
    </div>
  ) : (
    <ResponsiveGridLayout
      className="layout"
      {...gridProps}
      rowHeight={GRID_ROW_HEIGHT}
      margin={[GRID_MARGIN, GRID_MARGIN]}
      isDraggable={editing}
      isResizable={editing}
      draggableHandle=".widget-drag-handle"
      draggableCancel=".widget-no-drag"
      onDragStop={(l) => void actions.saveLayout(l)}
      onResizeStop={(l) => void actions.saveLayout(l)}
    >
      {dashboard.widgets.map((widget) => (
        <div key={widget.id}>
          <WidgetCard widget={widget} dashboard={dashboard} />
        </div>
      ))}
    </ResponsiveGridLayout>
  );

  const store = useEditorStore.getState;
  const shelfOpen = useEditorStore((s) => s.shelfOpen);
  const panelOpen = useEditorStore((s) => s.panelOpen);
  const partsOpen = useEditorStore((s) => s.partsOpen);
  const dragging = useEditorStore((s) => s.dragging);

  // ドラッグを始めたら、棚と部品バーを隠して、置き先のキャンバスを見せる（始めた直後に DOM を変えるとドラッグが
  // 取り消されるブラウザがあるため、少し遅らせる）。設定パネルは、パネル内の枠にも置けるよう隠さない
  const [hideWhileDragging, setHideWhileDragging] = useState(false);
  useEffect(() => {
    if (!dragging) {
      setHideWhileDragging(false);
      return;
    }
    const timer = setTimeout(() => setHideWhileDragging(true), 60);
    return () => clearTimeout(timer);
  }, [dragging]);
  const hiddenClass = hideWhileDragging ? "pointer-events-none opacity-0" : "";

  // 窓（棚・パネル）の上端は、時間の操作の下に合わせる（画面の幅で行数が変わっても、実測でずれない）。
  // スクロールしてヘッダーが見えなくなれば、窓も上へ寄せる
  const controlsRef = useRef<HTMLDivElement>(null);
  const [drawerTop, setDrawerTop] = useState(156);
  useEffect(() => {
    if (!editing) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bottom = controlsRef.current?.getBoundingClientRect().bottom ?? 148;
        setDrawerTop(Math.max(8, Math.round(bottom + 8)));
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [editing]);

  // 設定パネルは、選んだウィジェットを覆わない側に出す（右 → 左 → 下）。ウィジェットの位置は、選んだとき・画面の幅が
  // 変わったとき・棚を開閉したときに測り直す。下に出すときは、ウィジェットが窓の上に見えるようスクロールする
  const selectedWidgetId = useEditorStore((s) => s.selectedWidgetId);
  const selectedWidget = dashboard.widgets.find((w) => w.id === selectedWidgetId);
  const [placement, setPlacement] = useState<PanelPlacement>("right");
  const placementKey = `${selectedWidgetId}:${selectedWidget?.gridColumn}:${selectedWidget?.gridWidth}:${selectedWidget?.gridRow}:${selectedWidget?.gridHeight}:${shelfOpen}:${panelOpen}`;
  useLayoutEffect(() => {
    if (!editing || !panelOpen) return;
    const measure = () => {
      const el = selectedWidgetId ? document.querySelector<HTMLElement>(`[data-widget-id="${selectedWidgetId}"]`) : null;
      const box = el?.getBoundingClientRect();
      const next = choosePanelPlacement({
        widget: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        shelfOpen,
        drawerTop,
      });
      setPlacement(next);
      if (next === "bottom" && box) {
        // 下の窓（画面の高さの 45%）より上に、ウィジェットの下端が来るようにする
        const visibleBottom = window.innerHeight * 0.55 - 16;
        if (box.bottom > visibleBottom) window.scrollBy({ top: box.bottom - visibleBottom });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // drawerTop はスクロールで変わるが、測り直しはしない（スクロールのたびに窓が動かないように）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, placementKey]);

  const drawerBase =
    "fixed z-30 flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg transition-opacity";

  return (
    <div className="px-2 py-4 sm:p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => selectDashboard(null)}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← 一覧へ
          </button>
          <div>
            <h1 className="text-xl font-bold text-gray-900">{dashboard.name}</h1>
            {dashboard.description && <p className="text-xs text-gray-400">{dashboard.description}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                aria-pressed={shelfOpen}
                onClick={() => store().setShelfOpen(!shelfOpen)}
                className={`rounded border px-3 py-1.5 text-sm ${shelfOpen ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 hover:bg-gray-50"}`}
              >
                センサー
              </button>
              <div className="relative">
                <button
                  type="button"
                  aria-expanded={partsOpen}
                  onClick={() => store().setPartsOpen(!partsOpen)}
                  className={`rounded border px-3 py-1.5 text-sm ${partsOpen ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 hover:bg-gray-50"}`}
                >
                  ＋ ウィジェット
                </button>
                {partsOpen && (
                  <div className={`absolute right-0 top-full z-40 mt-1 transition-opacity ${hiddenClass}`}>
                    <WidgetPalette dashboard={dashboard} />
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-pressed={panelOpen}
                onClick={() => store().setPanelOpen(!panelOpen)}
                className={`rounded border px-3 py-1.5 text-sm ${panelOpen ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 hover:bg-gray-50"}`}
              >
                設定
              </button>
              <button
                type="button"
                disabled={historySize === 0}
                onClick={() => void actions.undo()}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                ↶ 元に戻す
              </button>
              <button
                type="button"
                onClick={() => store().stopEditing()}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                ✓ 編集を終わる
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => store().startEditing()}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              ✎ 編集する
            </button>
          )}
        </div>
      </div>

      <div ref={controlsRef}>
        <TimeRangeControls />
      </div>

      {!editing && dashboard.widgets.length === 0 ? (
        <p className="text-sm text-gray-400">
          まだウィジェットがありません。「編集する」を押して、センサーを置いてみましょう。
        </p>
      ) : (
        <DropSurface dashboard={dashboard} editing={editing}>
          {grid}
        </DropSurface>
      )}

      {editing && shelfOpen && (
        <aside
          aria-label="センサー棚"
          style={{ top: drawerTop }}
          className={`${drawerBase} bottom-2 left-2 w-[272px] max-w-[calc(100vw-1rem)] ${hiddenClass}`}
        >
          <EditorShelf dashboard={dashboard} />
        </aside>
      )}
      {editing && panelOpen && (
        <aside
          aria-label="設定パネル"
          data-placement={placement}
          style={
            placement === "bottom"
              ? { height: "45vh" }
              : placement === "left"
                ? { top: drawerTop, left: leftPanelOffset(shelfOpen) }
                : { top: drawerTop }
          }
          className={`${drawerBase} ${
            placement === "bottom" ? "inset-x-2 bottom-2" : placement === "left" ? "bottom-2 w-[316px]" : "bottom-2 right-2 w-[316px]"
          } max-w-[calc(100vw-1rem)]`}
        >
          <SettingsPanel dashboard={dashboard} />
        </aside>
      )}

      <EditorToast />
    </div>
  );
}
