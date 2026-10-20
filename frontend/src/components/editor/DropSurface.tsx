/**
 * 格子（ウィジェットを並べる場所）を包み、棚からのドラッグ＆ドロップを受ける。
 *
 * - 空きの上: 置く場所に点線の枠を出す（ほかのウィジェットと重なるときは、重ならない場所に出す）。
 *   ドロップすると、センサーなら種類に合うウィジェットを、ウィジェットの種類ならそれを新しく作る
 * - ウィジェットの上: 「このグラフに追加」（Shift を押しながらなら入れ替え）などを出す。ドロップでセンサーを割り当てる
 * 編集モードでは、列と行の目印（点）も、格子の上に重ねて描く。
 * 閲覧と編集で、格子の位置と大きさが変わらないよう、この枠は両方のモードで同じ構造・同じ余白にし、
 * 編集専用の飾り（点・枠線・ヒント）は、寸法に影響しない重ね表示（absolute）にする。ドロップの処理は編集中だけ働く。
 *
 * 【誰が使うか】DashboardView（閲覧・編集の両方の格子）。
 * 【引数（props）】dashboard = 編集中のダッシュボード、editing = 編集中か、children = 格子（react-grid-layout）。
 */
import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { useSensors } from "../../hooks/queries";
import { useElementSize } from "../../hooks/useElementSize";
import { useWidgetActions } from "../../hooks/useWidgetActions";
import {
  GRID_MARGIN,
  GRID_ROW_HEIGHT,
  columnWidth,
  findFreeSpot,
  pointToCell,
  rectToPixels,
  type GridRect,
} from "../../lib/grid-placement";
import { guessSensorKind } from "../../lib/sensor-kind";
import { defaultWidgetFor, widgetKind } from "../../lib/widget-catalog";
import { acceptsSensor } from "../../lib/widget-sensors";
import { useEditorStore } from "../../store/useEditorStore";
import type { DashboardDetail, Widget } from "../../types";

type Hover =
  | { kind: "cell"; rect: GridRect }
  | { kind: "widget"; widget: Widget; label: string; box: { left: number; top: number; width: number; height: number } };

const isGraph = (w: Widget) => w.type === "SensorGraph" || w.type === "MultiSensorComparison";

export function DropSurface({
  dashboard,
  editing,
  children,
}: {
  dashboard: DashboardDetail;
  editing: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);
  const [hover, setHover] = useState<Hover | null>(null);
  const { data: sensors } = useSensors();
  const actions = useWidgetActions(dashboard);
  const metrics = { containerWidth: width, rowHeight: GRID_ROW_HEIGHT, margin: GRID_MARGIN };

  /** ポインタの位置から、いまドロップしたらどうなるかを求める。ドラッグ中のものが無ければ null */
  const resolveHover = (e: DragEvent): Hover | null => {
    const payload = useEditorStore.getState().dragging;
    const surface = ref.current;
    if (!payload || !surface) return null;
    const surfaceBox = surface.getBoundingClientRect();

    // センサーをウィジェットの上に持ってきたとき
    const widgetEl = (e.target as HTMLElement).closest<HTMLElement>("[data-widget-id]");
    const widget = widgetEl && dashboard.widgets.find((w) => w.id === widgetEl.dataset.widgetId);
    if (payload.kind === "sensor" && widget && widgetEl) {
      if (!acceptsSensor(widget)) return null;
      const box = widgetEl.getBoundingClientRect();
      const label = isGraph(widget)
        ? e.shiftKey
          ? "このグラフと入れ替え"
          : "このグラフに追加（Shift で入れ替え）"
        : "このウィジェットに切り替え";
      return {
        kind: "widget",
        widget,
        label,
        box: { left: box.left - surfaceBox.left, top: box.top - surfaceBox.top, width: box.width, height: box.height },
      };
    }

    // 空きに置く: 置くウィジェットの大きさで、ポインタの位置を中心に場所を探す
    const type =
      payload.kind === "widgetType"
        ? payload.type
        : defaultWidgetFor(guessSensorKind(sensors?.find((s) => s.id === payload.sensorId) ?? { name: "", unit: "" }));
    const size = widgetKind(type);
    if (!size) return null;
    const cell = pointToCell(metrics, e.clientX - surfaceBox.left, e.clientY - surfaceBox.top);
    const rect = findFreeSpot(dashboard.widgets, size.width, size.height, cell.column - Math.floor(size.width / 2), cell.row);
    return { kind: "cell", rect };
  };

  const updateHover = (next: Hover | null) =>
    setHover((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));

  const onDragOver = (e: DragEvent) => {
    if (!useEditorStore.getState().dragging) return;
    const next = resolveHover(e);
    updateHover(next);
    if (next) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (e: DragEvent) => {
    const payload = useEditorStore.getState().dragging;
    const target = resolveHover(e);
    setHover(null);
    useEditorStore.getState().setDragging(null);
    if (!payload || !target) return;
    e.preventDefault();
    const sensor = payload.kind === "sensor" ? sensors?.find((s) => s.id === payload.sensorId) : undefined;
    if (target.kind === "widget" && sensor) {
      void actions.assign(target.widget, sensor, e.shiftKey ? "replace" : "add");
    } else if (target.kind === "cell") {
      const position = { column: target.rect.column, row: target.rect.row };
      if (payload.kind === "widgetType") void actions.addByType(payload.type, position);
      else if (sensor) void actions.addSensor(sensor, position);
    }
  };

  // 列と行の目印（点）。react-grid-layout の余白と同じ寸法で並べる
  const cellWidth = width > 0 ? columnWidth(metrics) + GRID_MARGIN : 0;
  const cellHeight = GRID_ROW_HEIGHT + GRID_MARGIN;
  const dotStyle =
    cellWidth > 0
      ? {
          backgroundImage: "radial-gradient(#cbd5e1 1.2px, transparent 1.4px)",
          backgroundSize: `${cellWidth}px ${cellHeight}px`,
          backgroundPosition: `${GRID_MARGIN / 2}px ${GRID_MARGIN / 2}px`,
        }
      : undefined;

  return (
    <div
      ref={ref}
      onDragOver={editing ? onDragOver : undefined}
      onDragLeave={
        editing
          ? (e) => {
              // ウィジェットなど内側の要素をまたいだだけのときは、点線を消さない
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null);
            }
          : undefined
      }
      onDrop={editing ? onDrop : undefined}
      className="relative min-h-[420px] pb-20"
    >
      {editing && (
        // 列と行の目印と、キャンバスの縁。格子の下に敷く（寸法に影響しない）
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-lg outline-dashed outline-1 outline-slate-300" style={dotStyle} />
      )}
      {children}
      {editing && dashboard.widgets.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-4 text-center text-sm text-gray-500">
          <div className="rounded-xl border-2 border-dashed border-gray-300 bg-white/70 px-5 py-4">
            <b className="text-base text-gray-900">ここにセンサーをドラッグしてみましょう</b>
            <br />
            左の一覧から、好きなセンサーをここへ。グラフや生産管理が自動でできあがります。
          </div>
        </div>
      )}
      {hover?.kind === "cell" && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 grid place-items-center rounded-lg border-2 border-dashed border-blue-600 bg-blue-50/70 text-sm font-bold text-blue-600"
          style={rectToPixels(metrics, hover.rect)}
        >
          ここに置く
        </div>
      )}
      {hover?.kind === "widget" && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 grid place-items-center rounded-lg border-2 border-dashed border-blue-600 bg-blue-50/85 text-sm font-bold text-blue-600"
          style={hover.box}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}
