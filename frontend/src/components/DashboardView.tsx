/**
 * ダッシュボードの表示画面。
 * ウィジェットを 12 列の格子（react-grid-layout）に置く。
 *
 * 「編集する」を押すと編集モードになる。閲覧と編集で、ウィジェットの位置・大きさ・ヘッダーの高さが変わらないよう、
 * 格子（キャンバス）は両方のモードで同じ幅・同じ位置にし、編集用の窓はキャンバスの上に重ねて出す（どれも閉じられる）:
 * - 左: センサー棚（ドラッグ、または「＋」で追加）
 * - 上のバー: 「＋ ウィジェット」で種類の部品バーを開く（ドラッグ、またはクリックで追加）
 * - 右: 設定パネル（ウィジェットの「⚙」で、そのウィジェットの設定。未選択ならダッシュボードの名前・説明）
 * ウィジェットは、カードをつかんで移動、右下の角・左右と下の端で大きさを変える。設定は、ウィジェット内の「⚙」ボタンで開く。
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
import { choosePanelSlot, NARROW_VIEWPORT, type PanelSlot, type ViewRect } from "../lib/panel-placement";
import { clampWindowSize, isWindowPositionInside, MIN_WINDOW_HEIGHT, WINDOW_WIDTH } from "../lib/window-position";
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
// スマホで、2 つ横に並べる小さなウィジェット
const COMPACT_WIDGET_TYPES: Widget["type"][] = ["StatValue", "Gauge"];
// スマホ用の下部ナビ（App.tsx の BottomNav、min-h-14）の高さ（px）
const BOTTOM_NAV_HEIGHT = 56;

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
  const kiosk = useUiStore((s) => s.kiosk);
  const setKiosk = useUiStore((s) => s.setKiosk);

  // 画面表示モード: 全画面にして、画面が消えないようにする。全画面を Esc などで抜けたら、モードも終える
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    if (!kiosk) return;
    let wakeLock: { release: () => Promise<void> } | null = null;
    const requestWakeLock = () => {
      // 対応していない端末（古いブラウザ）では何もしない。画面を隠したあと戻ったときは取り直す
      void (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<typeof wakeLock> } }).wakeLock
        ?.request("screen")
        .then((lock) => (wakeLock = lock))
        .catch(() => undefined);
    };
    requestWakeLock();
    const onVisible = () => document.visibilityState === "visible" && requestWakeLock();
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setKiosk(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setKiosk(false);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("keydown", onKeyDown);
      void wakeLock?.release().catch(() => undefined);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [kiosk, setKiosk]);
  // 編集に入ったら、画面表示モードは終える
  useEffect(() => {
    if (editing) setKiosk(false);
  }, [editing, setKiosk]);

  // キーボード: Ctrl/⌘+Z で元に戻す、Delete で選択中を削除、Esc で選択を外す
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      // センサーを選ぶ欄の中では、Delete・Ctrl+Z を画面のウィジェットに効かせない（選ぶ操作の最中に消えないように）
      if (e.target instanceof Element && e.target.closest("[data-sensor-field]")) return;
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

  // 画面表示モードで、パソコンの大きな画面なら、行の高さを調整して、全体が 1 画面に収まるようにする（スクロール不要）。
  // 格子の高さ = 行数 × 行の高さ + (行数 + 1) × 間隔（上下の余白も間隔と同じ）
  const rowCount = Math.max(1, ...dashboard.widgets.map((w) => w.gridRow - 1 + w.gridHeight));
  const rowHeight = kiosk && !isNarrow
    ? Math.max(20, Math.floor((viewportHeight - 16 - (rowCount + 1) * GRID_MARGIN) / rowCount))
    : GRID_ROW_HEIGHT;

  const grid = isNarrow ? (
    // スマホ: 格子をやめて、ウィジェットを縦に並べる。小さな数値・メーターは 2 つ横に並べ、グラフなどは全幅にする
    <div className="grid grid-cols-2 gap-3">
      {dashboard.widgets.map((widget) => {
        const compact = COMPACT_WIDGET_TYPES.includes(widget.type);
        return (
          <div key={widget.id} className={compact ? "col-span-1 h-36" : widget.type === "SensorGraph" || widget.type === "MultiSensorComparison" ? "col-span-2 h-72" : "col-span-2 h-44"}>
            <WidgetCard widget={widget} dashboard={dashboard} />
          </div>
        );
      })}
    </div>
  ) : (
    <ResponsiveGridLayout
      className="layout"
      {...gridProps}
      rowHeight={rowHeight}
      margin={[GRID_MARGIN, GRID_MARGIN]}
      isDraggable={editing}
      isResizable={editing}
      draggableHandle=".widget-drag-handle"
      draggableCancel=".widget-no-drag"
      // 右下の角に加え、左右の端・下の端・左下の角でも大きさを変えられる
      resizeHandles={["se", "sw", "e", "w", "s"]}
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
    // 時間の操作の高さが変わっても（カスタム期間の入力欄で行が増えるなど）、窓の上端を追従させる
    const observer = typeof ResizeObserver !== "undefined" && controlsRef.current ? new ResizeObserver(update) : null;
    if (observer && controlsRef.current) observer.observe(controlsRef.current);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [editing]);

  // 設定パネルは、選んだウィジェットを覆わない側に出す（右 → 左 → 下）。ウィジェットの位置は、選んだとき・画面の幅が
  // 変わったとき・棚を開閉したときに測り直す。下に出すときは、ウィジェットが窓の上に見えるようスクロールする
  const selectedWidgetId = useEditorStore((s) => s.selectedWidgetId);
  const selectedWidget = dashboard.widgets.find((w) => w.id === selectedWidgetId);
  const [slot, setSlot] = useState<PanelSlot>({ placement: "right" });
  const shelfPos = useEditorStore((s) => s.shelfPos);
  // 画面が小さくなって、動かした棚が画面の外になったら、位置を捨てて既定の場所に戻す
  // 画面の幅・高さ（変わったら、棚の位置と下寄せの切り替えを描き直す）
  const [, setViewportTick] = useState(0);
  useEffect(() => {
    const onResize = () => {
      setViewportTick((n) => n + 1);
      const store = useEditorStore.getState();
      // 表示だけ既定の場所に戻し、保存した位置は残す（ズーム・タブレットの回転・仮想キーボードで、保存が消えないように。
      // 画面が元の大きさに戻った次の編集で、保存した位置が画面内なら復元される）
      if (store.shelfPos && !isWindowPositionInside("shelf", store.shelfPos, window.innerWidth, window.innerHeight)) {
        store.setShelfPos(null, { persist: false });
      }
      if (store.panelPos && !isWindowPositionInside("panel", store.panelPos, window.innerWidth, window.innerHeight)) {
        store.setPanelPos(null, { persist: false });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // 棚の矩形（画面上）。動かしていなければ既定の場所（左上に固定、下まで）。狭い画面は、動かした位置を使わない
  const narrowNow = window.innerWidth < NARROW_VIEWPORT;
  const movedShelf = shelfPos && !narrowNow ? shelfPos : null;
  // ユーザーが設定パネルを動かしたら、その位置を使う（選ぶウィジェットが変わっても、自動配置で位置を変えない）。
  // 640px 未満は動かせないので、従来どおり自動配置（下寄せ）。「もとの位置」で自動配置に戻る
  const panelPos = useEditorStore((s) => s.panelPos);
  const movedPanel = panelPos && !narrowNow ? panelPos : null;
  const placement = movedPanel ? "moved" : slot.placement;
  // 動かした窓の大きさ。利用者が大きさを変えていれば、それを（画面に収まる範囲に丸めて）使う。
  // 変えていなければ、幅は既定、高さは最初に動かしたときに急に縮まないよう、既定の位置の高さ（画面の高さ − 164）を上限にする
  const shelfSize = useEditorStore((s) => s.shelfSize);
  const panelSize = useEditorStore((s) => s.panelSize);
  const boxOf = (kind: "shelf" | "panel", pos: { x: number; y: number }, size: typeof shelfSize) =>
    clampWindowSize(
      kind,
      size ?? {
        width: WINDOW_WIDTH[kind],
        height: Math.max(MIN_WINDOW_HEIGHT, Math.min(window.innerHeight - 164, window.innerHeight - pos.y - 8)),
      },
      pos,
      window.innerWidth,
      window.innerHeight,
    );
  const panelBox = movedPanel ? boxOf("panel", movedPanel, panelSize) : null;
  const shelfBox = movedShelf ? boxOf("shelf", movedShelf, shelfSize) : null;
  const shelfRect: ViewRect | null = !shelfOpen
    ? null
    : movedShelf && shelfBox
      ? { left: movedShelf.x, top: movedShelf.y, right: movedShelf.x + shelfBox.width, bottom: movedShelf.y + shelfBox.height }
      : { left: 8, top: drawerTop, right: 8 + WINDOW_WIDTH.shelf, bottom: window.innerHeight - (narrowNow ? BOTTOM_NAV_HEIGHT + 8 : 8) };
  // 既定の位置の棚は、上端が時間の操作に追従してスクロールで変わる。それを鍵に含めると、スクロールのたびに
  // 設定パネルの位置が測り直されて切り替わるので、既定の位置は「default」とだけ区別する
  const shelfKey = !shelfRect ? "closed" : movedShelf ? `${shelfRect.left},${shelfRect.top},${shelfRect.right},${shelfRect.bottom}` : "default";
  const placementKey = `${selectedWidgetId}:${selectedWidget?.gridColumn}:${selectedWidget?.gridWidth}:${selectedWidget?.gridRow}:${selectedWidget?.gridHeight}:${shelfKey}:${panelOpen}:${movedPanel ? "moved" : "auto"}`;
  useLayoutEffect(() => {
    // 動かした位置を使うときは、自動配置の計算をしない
    if (!editing || !panelOpen || movedPanel) return;
    const measure = () => {
      const el = selectedWidgetId ? document.querySelector<HTMLElement>(`[data-widget-id="${selectedWidgetId}"]`) : null;
      const box = el?.getBoundingClientRect();
      const next = choosePanelSlot({
        widget: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        shelf: shelfRect,
        drawerTop,
        bottomGap: window.innerWidth < NARROW_VIEWPORT ? BOTTOM_NAV_HEIGHT + 8 : 8,
      });
      // 同じ結果なら、状態を更新しない（無駄な再描画を避ける）
      setSlot((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // drawerTop はスクロールで変わるが、測り直しはしない（スクロールのたびに窓が動かないように）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, placementKey]);

  // 狭い画面（640px 未満）は、画面の下に固定の下部ナビ（高さ 56px）がある。窓がそれに隠れないよう、その分だけ上げる
  const drawerBottom = window.innerWidth < NARROW_VIEWPORT ? BOTTOM_NAV_HEIGHT + 8 : 8;
  // 下に出すときは、ウィジェットが下の窓（画面の高さの 45%）より上に見えるようスクロールする。
  // 窓の分の余白（ページの下の padding）が付いたあとでないと、ページが短くてスクロールできないため、placement が決まってから行う
  useLayoutEffect(() => {
    // 棚を動かしている最中は、スクロールしない（動かすたびに画面が動かないように）
    if (!editing || !panelOpen || placement !== "bottom" || !selectedWidgetId || useEditorStore.getState().shelfMoving) return;
    const el = document.querySelector<HTMLElement>(`[data-widget-id="${selectedWidgetId}"]`);
    const box = el?.getBoundingClientRect();
    // 窓の上端 = 画面の高さ − 窓の高さ（45%）− 窓の下の余白（狭い画面は下部ナビの分）
    const bottomGap = window.innerWidth < NARROW_VIEWPORT ? BOTTOM_NAV_HEIGHT + 8 : 8;
    const visibleBottom = window.innerHeight * 0.55 - bottomGap - 16;
    if (box && box.bottom > visibleBottom) window.scrollBy({ top: box.bottom - visibleBottom });
  }, [editing, panelOpen, placement, selectedWidgetId]);

  const drawerBase =
    "fixed z-30 flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg transition-opacity";

  return (
    <div
      className={kiosk ? "min-h-screen bg-gray-50 p-1" : "px-2 py-4 sm:p-4"}
      // 設定パネルを下に出すときは、ページの下に窓の高さの余白を足す（ウィジェットを窓の上までスクロールできるように）。上の位置は変わらない
      style={editing && panelOpen && placement === "bottom" ? { paddingBottom: "50vh" } : undefined}
    >
      {kiosk && (
        // 画面表示モードの終了ボタン。邪魔にならないよう小さく、薄く右上に置く（Esc でも終えられる）
        <button
          type="button"
          onClick={() => setKiosk(false)}
          aria-label="画面表示を終える"
          className="fixed right-2 top-2 z-50 rounded-full bg-gray-900/40 px-3 py-1.5 text-xs text-white opacity-50 hover:opacity-100 active:opacity-100"
        >
          ✕ 終える
        </button>
      )}
      {!kiosk && <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
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
                aria-label="センサー"
                title="センサー"
                onClick={() => store().setShelfOpen(!shelfOpen)}
                className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm ${shelfOpen ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 hover:bg-gray-50"}`}
              >
                <span aria-hidden="true">◫</span>
                <span className="hidden lg:inline">センサー</span>
              </button>
              <div className="relative">
                <button
                  type="button"
                  aria-expanded={partsOpen}
                aria-label="ウィジェット"
                title="ウィジェット"
                  onClick={() => store().setPartsOpen(!partsOpen)}
                  className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm ${partsOpen ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 hover:bg-gray-50"}`}
                >
                  <span aria-hidden="true">＋</span>
                <span className="hidden lg:inline">ウィジェット</span>
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
                aria-label="設定"
                title="設定"
                onClick={() => store().setPanelOpen(!panelOpen)}
                className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm ${panelOpen ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 hover:bg-gray-50"}`}
              >
                <span aria-hidden="true">⚙</span>
                <span className="hidden lg:inline">設定</span>
              </button>
              <button
                type="button"
                disabled={historySize === 0}
                aria-label="元に戻す"
                title="元に戻す"
                onClick={() => void actions.undo()}
                className="inline-flex items-center gap-1.5 rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                <span aria-hidden="true">↶</span>
                <span className="hidden lg:inline">元に戻す</span>
              </button>
              <button
                type="button"
                onClick={() => store().stopEditing()}
                aria-label="編集を終わる"
                title="編集を終わる"
                className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                <span aria-hidden="true">✓</span>
                <span className="hidden sm:inline">編集を終わる</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  // 全画面は、ボタンを押した操作の中でしか要求できない。対応していない端末（iPhone など）は、全画面なしで表示だけ切り替える
                  setKiosk(true);
                  void document.documentElement.requestFullscreen?.().catch(() => undefined);
                }}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                ▣ 画面表示
              </button>
              <button
                type="button"
                onClick={() => store().startEditing()}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                ✎ 編集する
              </button>
            </>
          )}
        </div>
      </div>}

      {!kiosk && (
        <div ref={controlsRef}>
          <TimeRangeControls />
        </div>
      )}

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
          style={
            movedShelf && shelfBox
              ? { top: movedShelf.y, left: movedShelf.x, width: shelfBox.width, height: shelfBox.height }
              : { top: drawerTop, bottom: drawerBottom, left: 8 }
          }
          className={`${drawerBase} w-[272px] max-w-[calc(100vw-1rem)] ${hiddenClass}`}
        >
          <EditorShelf dashboard={dashboard} />
        </aside>
      )}
      {editing && panelOpen && (
        <aside
          aria-label="設定パネル"
          data-placement={placement}
          style={
            movedPanel && panelBox
              ? { top: movedPanel.y, left: movedPanel.x, width: panelBox.width, height: panelBox.height }
              : placement === "bottom"
              ? // 下に出すときは、開いているセンサー棚を避けた範囲に出す（棚と重ならない）
                { height: "45vh", bottom: drawerBottom, left: slot.placement === "bottom" ? slot.left : 8, right: slot.placement === "bottom" ? slot.right : 8 }
              : slot.placement === "left"
                ? { top: drawerTop, bottom: drawerBottom, left: slot.left }
                : { top: drawerTop, bottom: drawerBottom }
          }
          className={`${drawerBase} ${
            placement === "bottom" ? "" : placement === "left" || placement === "moved" ? "w-[316px]" : "right-2 w-[316px]"
          } max-w-[calc(100vw-1rem)]`}
        >
          <SettingsPanel dashboard={dashboard} />
        </aside>
      )}

      <EditorToast />
    </div>
  );
}
