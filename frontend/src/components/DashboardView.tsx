import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useDashboard } from "../hooks/queries";
import { deleteDashboard, updateWidget } from "../lib/api";
import { useUiStore } from "../store/useUiStore";
import { AddWidgetModal } from "./AddWidgetModal";
import { WidgetCard } from "./WidgetCard";

export function DashboardView({ dashboardId }: { dashboardId: string }) {
  const { data: dashboard, isLoading } = useDashboard(dashboardId);
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const [isModalOpen, setModalOpen] = useState(false);
  const queryClient = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const deleteDashboardMutation = useMutation({
    mutationFn: () => deleteDashboard(dashboardId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      selectDashboard(null);
    },
  });

  const swapMutation = useMutation({
    mutationFn: async (vars: {
      a: { id: string; gridColumn: number; gridRow: number };
      b: { id: string; gridColumn: number; gridRow: number };
    }) => {
      await Promise.all([
        updateWidget(vars.a.id, { gridColumn: vars.b.gridColumn, gridRow: vars.b.gridRow }),
        updateWidget(vars.b.id, { gridColumn: vars.a.gridColumn, gridRow: vars.a.gridRow }),
      ]);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    },
  });

  if (isLoading || !dashboard) {
    return <p className="p-4 text-sm text-gray-400">読み込み中...</p>;
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const widgetA = dashboard.widgets.find((w) => w.id === active.id);
    const widgetB = dashboard.widgets.find((w) => w.id === over.id);
    if (!widgetA || !widgetB) return;

    swapMutation.mutate({
      a: { id: widgetA.id, gridColumn: widgetA.gridColumn, gridRow: widgetA.gridRow },
      b: { id: widgetB.id, gridColumn: widgetB.gridColumn, gridRow: widgetB.gridRow },
    });
  };

  return (
    <div className="p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => selectDashboard(null)}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← 一覧へ
          </button>
          <h1 className="text-xl font-bold text-gray-900">{dashboard.name}</h1>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            + ウィジェット追加
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm("このダッシュボードを削除しますか？")) {
                deleteDashboardMutation.mutate();
              }
            }}
            className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
          >
            削除
          </button>
        </div>
      </div>

      {dashboard.widgets.length === 0 ? (
        <p className="text-sm text-gray-400">
          まだウィジェットがありません。「+ ウィジェット追加」から追加してください。
        </p>
      ) : (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {dashboard.widgets.map((widget) => (
              <WidgetCard key={widget.id} widget={widget} dashboardId={dashboardId} />
            ))}
          </div>
        </DndContext>
      )}

      {isModalOpen && (
        <AddWidgetModal dashboard={dashboard} onClose={() => setModalOpen(false)} />
      )}
    </div>
  );
}
