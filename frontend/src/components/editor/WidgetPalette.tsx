/**
 * ウィジェットの部品バー。「＋ ウィジェット」を押すと、種類が横に並ぶ。
 * 種類をキャンバスにドラッグして置ける。クリックでも追加できる（ドラッグできない人のため）。
 * センサー棚とは別の窓で、キャンバスの上に重ねて出す（キャンバスの大きさを変えないため）。
 *
 * 【誰が使うか】DashboardView（編集モードの上部）。
 * 【引数（props）】dashboard = 編集中のダッシュボード。
 */
import { useWidgetActions } from "../../hooks/useWidgetActions";
import { WIDGET_KINDS } from "../../lib/widget-catalog";
import { useEditorStore } from "../../store/useEditorStore";
import type { DashboardDetail } from "../../types";
import { WidgetIcon } from "./WidgetIcon";

export function WidgetPalette({ dashboard }: { dashboard: DashboardDetail }) {
  const setDragging = useEditorStore((s) => s.setDragging);
  const setPartsOpen = useEditorStore((s) => s.setPartsOpen);
  const actions = useWidgetActions(dashboard);

  return (
    <div
      role="group"
      aria-label="ウィジェットの種類"
      className="flex w-[min(780px,calc(100vw-1rem))] flex-wrap gap-2 rounded-xl border border-gray-200 bg-white p-2.5 shadow-lg"
    >
      <p className="w-full text-xs text-gray-500">種類をキャンバスにドラッグ。置いた場所に入ります。クリックでも追加できます。</p>
      {WIDGET_KINDS.map((kind) => (
        <div
          key={kind.type}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", kind.label);
            e.dataTransfer.effectAllowed = "copy";
            setDragging({ kind: "widgetType", type: kind.type });
          }}
          onDragEnd={() => setDragging(null)}
        >
          <button
            type="button"
            title={kind.description}
            onClick={() => {
              setPartsOpen(false);
              void actions.addByType(kind.type);
            }}
            className="flex w-36 cursor-grab items-center gap-2 rounded-lg border border-gray-200 bg-white p-2 text-left hover:border-blue-500"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600">
              <WidgetIcon type={kind.type} size={18} />
            </span>
            <span className="min-w-0">
              <b className="block truncate text-sm">
                {kind.label}
                {kind.type === "ProductionPlan" && (
                  <em className="ml-1 rounded bg-blue-600 px-1 py-px align-[1px] text-[10px] font-bold not-italic text-white">NEW</em>
                )}
              </b>
              <span className="line-clamp-2 text-[11px] leading-tight text-gray-500">{kind.description}</span>
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
