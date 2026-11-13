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
import { Suspense, useRef, useState } from "react";

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
const TargetStripWidget = lazyNamed(() => import("./widgets/TargetStripWidget"), "TargetStripWidget");

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
    case "TargetStrip":
      return <TargetStripWidget widget={widget} />;
    default:
      return <p className="text-sm text-gray-500">未対応のウィジェットタイプ: {widget.type}</p>;
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
  // 利用者が付けたタイトル（空なら出さない）。枠の上に 1 行で出し、中身はその下に収める
  const title = widget.config.title?.trim() ?? "";
  // 編集モードでタイトルを書き換えるときの入力中の文字（null は書き換えていないとき）
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const titleCancelled = useRef(false);
  // タイトルの行を、枠の中身の上に置くか（タイトルがあるとき。編集中の入力の場所は、タイトルがないときは重ねて出す）
  const showsTitleLine = title !== "";

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 編集中のカード選択。キーボードは下の onKeyDown（Enter/Space）で対応済み
    <div
      data-widget-id={widget.id}
      role="group"
      aria-label={label}
      aria-current={editing && selected ? "true" : undefined}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 編集中は、カード全体を選択できる（枠にフォーカスして Enter/Space で選ぶ）。外枠は group のまま、中のボタンを入れ子にしないため
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
      } ${editing && selected ? "border-blue-600 outline outline-2 outline-blue-600" : "border-gray-200"} ${
        showsTitleLine ? "flex flex-col" : ""
      }`}
    >
      {titleDraft !== null ? (
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- 利用者が押して開いた入力欄なので、続けて入力できるようにフォーカスする
          autoFocus
          aria-label="タイトル"
          value={titleDraft}
          maxLength={40}
          placeholder="タイトルを入力"
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => {
            const next = titleCancelled.current ? title : (titleDraft ?? "").trim();
            titleCancelled.current = false;
            setTitleDraft(null);
            if (next !== title) void actions.patchConfig(widget, { title: next || undefined });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              titleCancelled.current = true;
              e.currentTarget.blur();
            }
          }}
          className={`widget-no-drag rounded border border-blue-400 bg-white px-1 text-sm font-semibold text-gray-800 ${
            title ? "mb-1 shrink-0" : "absolute left-1 top-1 z-10"
          }`}
        />
      ) : editing ? (
        // 編集モードでは、タイトルの文字をクリックするだけで書き換えられる（タイトルがないときは、入力の場所を出す）
        <button
          type="button"
          title="クリックしてタイトルを変える"
          onClick={(e) => {
            e.stopPropagation();
            setTitleDraft(title);
          }}
          className={`widget-no-drag block cursor-text truncate rounded px-1 text-left text-sm font-semibold text-gray-800 hover:bg-blue-50 ${
            title ? "mb-1 shrink-0" : "absolute left-1 top-1 z-10 max-w-[60%] bg-white/90"
          }`}
        >
          {title || <span className="font-normal text-gray-500">タイトルを入力</span>}
        </button>
      ) : (
        title && (
          <p className="mb-1 shrink-0 truncate text-sm font-semibold text-gray-800" title={title}>
            {title}
          </p>
        )
      )}
      <div className={`${showsTitleLine ? "min-h-0 flex-1" : "h-full"} overflow-hidden ${editing ? "pointer-events-none" : ""}`}>
        <ChunkErrorBoundary>
          <Suspense fallback={<p className="text-sm text-gray-500">読み込み中...</p>}>
            <WidgetBody widget={widget} />
          </Suspense>
        </ChunkErrorBoundary>
      </div>
      {editing && (
        // 編集用の操作は、カードの右上に重ねる（ウィジェットの寸法を変えない）。つかむ目印・設定・複製・削除
        <div className="absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-md border border-gray-200 bg-white/90 px-0.5 shadow-sm">
          <span aria-label="ドラッグして移動" role="img" title="カードをつかんで移動" className="px-1 text-xs text-gray-500">
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
