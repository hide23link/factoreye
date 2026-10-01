import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteWidget, updateWidget } from "../lib/api";
import type { Widget } from "../types";
import { AlarmAlertWidget } from "./widgets/AlarmAlertWidget";
import { MultiSensorComparisonWidget } from "./widgets/MultiSensorComparisonWidget";
import { ProductionStatusWidget } from "./widgets/ProductionStatusWidget";
import { SensorGraphWidget } from "./widgets/SensorGraphWidget";

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
    default:
      return <p className="text-sm text-gray-400">未対応のウィジェットタイプ: {widget.type}</p>;
  }
}

export function WidgetCard({ widget, dashboardId }: { widget: Widget; dashboardId: string }) {
  const queryClient = useQueryClient();
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: widget.id,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: widget.id });

  const deleteMutation = useMutation({
    mutationFn: () => deleteWidget(widget.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    },
  });

  const resizeMutation = useMutation({
    mutationFn: (data: { gridWidth?: number; gridHeight?: number }) =>
      updateWidget(widget.id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    },
  });

  const style = {
    gridColumn: `${widget.gridColumn} / span ${widget.gridWidth}`,
    gridRow: `${widget.gridRow} / span ${widget.gridHeight}`,
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      style={style}
      className={`flex min-h-[160px] flex-col rounded-lg border bg-white p-3 shadow-sm ${
        isOver ? "border-blue-400 ring-2 ring-blue-200" : "border-gray-200"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          {...listeners}
          {...attributes}
          className="cursor-grab touch-none select-none text-gray-400 hover:text-gray-600"
          aria-label="ドラッグして移動"
        >
          ⠿
        </button>
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <label>
            幅
            <select
              value={widget.gridWidth}
              onChange={(e) => resizeMutation.mutate({ gridWidth: Number(e.target.value) })}
              className="ml-1 rounded border border-gray-200 px-1"
            >
              {[1, 2, 3].map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <label>
            高さ
            <input
              type="number"
              min={1}
              max={3}
              value={widget.gridHeight}
              onChange={(e) => resizeMutation.mutate({ gridHeight: Number(e.target.value) })}
              className="ml-1 w-12 rounded border border-gray-200 px-1"
            />
          </label>
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            className="ml-1 text-red-400 hover:text-red-600"
            aria-label="ウィジェットを削除"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <WidgetBody widget={widget} />
      </div>
    </div>
  );
}
