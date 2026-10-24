/**
 * ダッシュボードに置かれた1つのウィジェットの枠。
 * 種類に応じた中身（WidgetBody）を選んで出す。
 *
 * 編集モードのときだけ、右上に（つかむ目印・設定・複製・削除）を重ねる。クリックで選択され、「設定」ボタンを押すと設定パネルに設定が出る。
 * 編集の前後で、枠の大きさ・中身の位置が変わらないようにする（見出しの帯などを足さない）。
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
const GaugeWidget = lazyNamed(() => import("./widgets/GaugeWidget"), "GaugeWidget");
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
    case "Gauge":
      return <GaugeWidget widget={widget} />;
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
  const openSettings = useEditorStore((s) => s.openSettings);
  // このウィジェットの設定パネルが開いているか（その場合は、設定ボタンをもう一度押すと閉じる）
  const settingsShown = useEditorStore((s) => s.panelOpen && s.selectedWidgetId === widget.id);
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
      // 編集中も、枠の大きさ・余白・中身の位置は閲覧中と同じ（枠線は同じ太さで色だけ変える。選択の強調は outline で、寸法に影響しない）。
      // 編集中は、カード全体をつかんで移動できる
      className={`relative h-full overflow-hidden rounded-lg border bg-white p-3 shadow-sm ${
        editing ? "widget-drag-handle cursor-grab touch-none active:cursor-grabbing" : ""
      } ${editing && selected ? "border-blue-600 outline outline-2 outline-blue-600" : "border-gray-200"}`}
    >
      <div className={`h-full overflow-hidden ${editing ? "pointer-events-none" : ""}`}>
        <ChunkErrorBoundary>
          <Suspense fallback={<p className="text-sm text-gray-400">読み込み中...</p>}>
            <WidgetBody widget={widget} />
          </Suspense>
        </ChunkErrorBoundary>
      </div>
      {editing && (
        // 編集用の操作は、カードの右上に重ねる（ウィジェットの寸法を変えない）。つかむ目印・設定・複製・削除
        <div className="absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-md border border-gray-200 bg-white/90 px-0.5 shadow-sm">
          <span aria-label="ドラッグして移動" role="img" title="カードをつかんで移動" className="px-1 text-xs text-gray-400">
            ⋮⋮
          </span>
          <button
            type="button"
            aria-label="ウィジェットの設定"
            aria-pressed={settingsShown}
            title={settingsShown ? "設定を閉じる" : "設定"}
            onClick={(e) => {
              e.stopPropagation();
              if (settingsShown) useEditorStore.getState().setPanelOpen(false);
              else openSettings(widget.id);
            }}
            className={`widget-no-drag h-6 w-6 rounded hover:bg-blue-50 hover:text-blue-700 ${
              settingsShown ? "bg-blue-50 text-blue-700" : "text-gray-500"
            }`}
          >
            ⚙
          </button>
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
    </div>
  );
}
