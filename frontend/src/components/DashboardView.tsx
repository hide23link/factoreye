import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Responsive, WidthProvider } from "react-grid-layout/legacy";
import type { Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { useDashboard } from "../hooks/queries";
import { deleteDashboard, updateDashboard, updateWidget } from "../lib/api";
import type { Widget } from "../types";
import { useUiStore } from "../store/useUiStore";
import { WidgetCard } from "./WidgetCard";
import { WidgetFormModal } from "./WidgetFormModal";

const ResponsiveGridLayout = WidthProvider(Responsive);

// react-grid-layout は0始まりのx/y、backendは1始まりのgridColumn/gridRow
const GRID_COLS = { lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 };
const ROW_HEIGHT = 36;

function toLayoutItem(widget: Widget): Layout[number] {
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

export function DashboardView({ dashboardId }: { dashboardId: string }) {
  const { data: dashboard, isLoading } = useDashboard(dashboardId);
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const [isModalOpen, setModalOpen] = useState(false);
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const deleteDashboardMutation = useMutation({
    mutationFn: () => deleteDashboard(dashboardId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      selectDashboard(null);
    },
  });

  const updateDashboardMutation = useMutation({
    mutationFn: () => updateDashboard(dashboardId, { name: editName, description: editDescription }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      setSettingsError(null);
      setSettingsOpen(false);
    },
    onError: (e: Error) => setSettingsError(e.message),
  });

  const openSettings = () => {
    if (!dashboard) return;
    setEditName(dashboard.name);
    setEditDescription(dashboard.description ?? "");
    setSettingsError(null);
    setSettingsOpen(true);
  };

  const persistLayoutMutation = useMutation({
    mutationFn: async (layout: Layout) => {
      if (!dashboard) return;
      const updates = layout.flatMap((item) => {
        const widget = dashboard.widgets.find((w) => w.id === item.i);
        if (!widget) return [];
        const next = { gridColumn: item.x + 1, gridRow: item.y + 1, gridWidth: item.w, gridHeight: item.h };
        const changed =
          widget.gridColumn !== next.gridColumn ||
          widget.gridRow !== next.gridRow ||
          widget.gridWidth !== next.gridWidth ||
          widget.gridHeight !== next.gridHeight;
        return changed ? [updateWidget(widget.id, next)] : [];
      });
      await Promise.all(updates);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    },
  });

  if (isLoading || !dashboard) {
    return <p className="p-4 text-sm text-gray-400">読み込み中...</p>;
  }

  const layout = dashboard.widgets.map(toLayoutItem);

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
          <div>
            <h1 className="text-xl font-bold text-gray-900">{dashboard.name}</h1>
            {dashboard.description && (
              <p className="text-xs text-gray-400">{dashboard.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={openSettings}
            className="text-xs text-gray-400 hover:text-blue-600"
            aria-label="ダッシュボード設定"
          >
            ⚙ 設定
          </button>
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
        <ResponsiveGridLayout
          className="layout"
          layouts={{ lg: layout, md: layout, sm: layout, xs: layout, xxs: layout }}
          breakpoints={{ lg: 1024, md: 768, sm: 576, xs: 400, xxs: 0 }}
          cols={GRID_COLS}
          rowHeight={ROW_HEIGHT}
          margin={[12, 12]}
          draggableHandle=".widget-drag-handle"
          onDragStop={(l) => persistLayoutMutation.mutate(l)}
          onResizeStop={(l) => persistLayoutMutation.mutate(l)}
        >
          {dashboard.widgets.map((widget) => (
            <div key={widget.id}>
              <WidgetCard widget={widget} dashboard={dashboard} />
            </div>
          ))}
        </ResponsiveGridLayout>
      )}

      {isModalOpen && (
        <WidgetFormModal dashboard={dashboard} onClose={() => setModalOpen(false)} />
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl">
            <h2 className="mb-3 text-lg font-bold">ダッシュボード設定</h2>
            <label className="mb-2 block text-sm">
              名前
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
            <label className="mb-3 block text-sm">
              説明
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
            {settingsError && <p className="mb-3 text-xs text-red-600">{settingsError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={!editName.trim() || updateDashboardMutation.isPending}
                onClick={() => updateDashboardMutation.mutate()}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
