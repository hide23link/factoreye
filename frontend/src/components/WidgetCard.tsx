/**
 * ダッシュボードに置かれた1つのウィジェットの枠。
 * 種類に応じた中身（WidgetBody）を選び、編集（WidgetFormModal）と削除の操作を付ける。
 * ドラッグで位置を変えられるように、つまみ（widget-drag-handle）を表示する。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { deleteWidget } from "../lib/api";
import type { DashboardDetail, Widget } from "../types";
import { WidgetFormModal } from "./WidgetFormModal";
import { AlarmAlertWidget } from "./widgets/AlarmAlertWidget";
import { MultiSensorComparisonWidget } from "./widgets/MultiSensorComparisonWidget";
import { ProductionStatusWidget } from "./widgets/ProductionStatusWidget";
import { SensorGraphWidget } from "./widgets/SensorGraphWidget";
import { StatValueWidget } from "./widgets/StatValueWidget";

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
    default:
      return <p className="text-sm text-gray-400">未対応のウィジェットタイプ: {widget.type}</p>;
  }
}

/** ウィジェットの枠（種類の中身・編集・削除）。 */
export function WidgetCard({
  widget,
  dashboard,
}: {
  widget: Widget;
  dashboard: DashboardDetail;
}) {
  const queryClient = useQueryClient();
  const [isEditing, setEditing] = useState(false);

  // 削除後は、ダッシュボードを取り直して、画面から消す
  const deleteMutation = useMutation({
    mutationFn: () => deleteWidget(widget.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboard.id] });
    },
  });

  return (
    <div className="flex h-full flex-col rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className="widget-drag-handle cursor-grab touch-none select-none text-gray-400 hover:text-gray-600"
          aria-label="ドラッグして移動"
        >
          ⠿
        </span>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="hover:text-blue-600"
            aria-label="ウィジェットを編集"
          >
            ⚙ 編集
          </button>
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            className="text-red-400 hover:text-red-600"
            aria-label="ウィジェットを削除"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <WidgetBody widget={widget} />
      </div>

      {isEditing && (
        <WidgetFormModal
          dashboard={dashboard}
          widget={widget}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
