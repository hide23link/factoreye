/**
 * ダッシュボードに置かれた1つのウィジェットの枠。
 * 種類に応じた中身（WidgetBody）を選んで出す。
 *
 * 編集モードのときだけ、見出し（つかんで移動）・複製・削除を出す。クリックで選択され、右の設定パネルに設定が出る。
 * 編集中は、中身へのマウス操作（グラフのドラッグ選択など）を止める。クリックを「選択」に使い、移動と競合させないため。
 *
 * 【誰が使うか】DashboardView.tsx が、ウィジェットの数だけ並べる。
 * 【引数（props）】widget = このウィジェット、dashboard = 属するダッシュボード（どちらも DashboardView が渡す）。
 */
import { Suspense } from "react";

import { useWidgetActions } from "../hooks/useWidgetActions";
import { lazyNamed } from "../lib/lazyWithRetry";
import { widgetLabel } from "../lib/widget-catalog";
import { useEditorStore } from "../store/useEditorStore";
import type { DashboardDetail, Widget } from "../types";
import { ChunkErrorBoundary } from "./ChunkErrorBoundary";
import { AlarmAlertWidget } from "./widgets/AlarmAlertWidget";
import { ProductionStatusWidget } from "./widgets/ProductionStatusWidget";

// グラフ系のウィジェット（recharts を使う）は、画面に出る時に読み込む
const SensorGraphWidget = lazyNamed(() => import("./widgets/SensorGraphWidget"), "SensorGraphWidget");
const MultiSensorComparisonWidget = lazyNamed(
  () => import("./widgets/MultiSensorComparisonWidget"),
  "MultiSensorComparisonWidget",
);
const StatValueWidget = lazyNamed(() => import("./widgets/StatValueWidget"), "StatValueWidget");
const ProductionPlanWidget = lazyNamed(() => import("./widgets/ProductionPlanWidget"), "ProductionPlanWidget");

/** ウィジェットの種類（type）に応じて、中身の部品を切り替える。未知の種類は注意文を出す。 */
function WidgetBody({ widget }: { widget: Widget }) {
  switch (widget.type) {
    case "SensorGraph":
      return <SensorGraphWidget widget={widget} />;
    case "AlarmAlert":
      return <AlarmAlertWidget />;
    case "ProductionStatus":
      return <ProductionStatusWidget widget={widget} />;
    case "MultiSensorComparison":
      return <MultiSensorComparisonWidget widget={widget} />;
    case "StatValue":
      return <StatValueWidget widget={widget} />;
    case "ProductionPlan":
      return <ProductionPlanWidget widget={widget} />;
    default:
      return <p className="text-sm text-gray-400">未対応のウィジェットタイプ: {widget.type}</p>;
  }
}

/** ウィジェットの枠（種類の中身。編集モードでは見出しと操作つき）。 */
export function WidgetCard({ widget, dashboard }: { widget: Widget; dashboard: DashboardDetail }) {
  const editing = useEditorStore((s) => s.editing);
  const selected = useEditorStore((s) => s.selectedWidgetId === widget.id);
  const select = useEditorStore((s) => s.select);
  const actions = useWidgetActions(dashboard);
  const label = widgetLabel(widget.type);

  return (
    <div
      data-widget-id={widget.id}
      role="group"
      aria-label={label}
      aria-current={editing && selected ? "true" : undefined}
      tabIndex={editing ? 0 : undefined}
      onClick={editing ? () => select(widget.id) : undefined}
      onKeyDown={
        editing
          ? (e) => {
              // 枠そのものにフォーカスがあるときだけ。中のボタンの Enter は、そのボタンの操作にする
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                select(widget.id);
              }
            }
          : undefined
      }
      className={`flex h-full flex-col overflow-hidden rounded-lg border bg-white shadow-sm ${
        editing && selected ? "border-blue-600 ring-2 ring-blue-600" : "border-gray-200"
      }`}
    >
      {editing && (
        <div className="widget-drag-handle flex h-8 shrink-0 cursor-grab touch-none select-none items-center gap-2 border-b border-gray-200 px-2 active:cursor-grabbing">
          <span aria-label="ドラッグして移動" role="img" className="text-gray-400">
            ⋮⋮
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-bold">{label}</span>
          <button
            type="button"
            aria-label="ウィジェットを複製"
            title="複製"
            onClick={(e) => {
              e.stopPropagation();
              void actions.duplicate(widget);
            }}
            className="widget-no-drag h-6 w-6 rounded text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            ⧉
          </button>
          <button
            type="button"
            aria-label="ウィジェットを削除"
            title="削除"
            onClick={(e) => {
              e.stopPropagation();
              void actions.remove(widget);
            }}
            className="widget-no-drag h-6 w-6 rounded text-gray-500 hover:bg-red-50 hover:text-red-600"
          >
            ✕
          </button>
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-hidden p-3 ${editing ? "pointer-events-none" : ""}`}>
        <ChunkErrorBoundary>
          <Suspense fallback={<p className="text-sm text-gray-400">読み込み中...</p>}>
            <WidgetBody widget={widget} />
          </Suspense>
        </ChunkErrorBoundary>
      </div>
    </div>
  );
}
