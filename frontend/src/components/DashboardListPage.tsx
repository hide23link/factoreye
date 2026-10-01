import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useDashboards } from "../hooks/queries";
import { createDashboard } from "../lib/api";
import { useUiStore } from "../store/useUiStore";

export function DashboardListPage() {
  const { data: dashboards, isLoading } = useDashboards();
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const setView = useUiStore((s) => s.setView);
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");

  const createMutation = useMutation({
    mutationFn: () => createDashboard({ name: newName }),
    onSuccess: (dashboard) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      setNewName("");
      selectDashboard(dashboard.id);
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-4">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">ダッシュボード一覧</h1>

      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) createMutation.mutate();
        }}
      >
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="新しいダッシュボード名"
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={createMutation.isPending || !newName.trim()}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          作成
        </button>
      </form>

      {isLoading && <p className="text-sm text-gray-400">読み込み中...</p>}

      {!isLoading && dashboards?.length === 0 && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="mb-2 text-sm text-blue-900">
            はじめての方は、5分のセットアップガイドでセンサー登録からダッシュボード表示までを体験できます。
          </p>
          <button
            type="button"
            onClick={() => setView("wizard")}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            セットアップガイドを始める
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {dashboards?.map((dashboard) => (
          <button
            key={dashboard.id}
            type="button"
            onClick={() => selectDashboard(dashboard.id)}
            className="rounded-lg border border-gray-200 bg-white p-4 text-left shadow-sm hover:border-blue-300 hover:shadow"
          >
            <p className="font-semibold text-gray-900">{dashboard.name}</p>
            {dashboard.description && (
              <p className="mt-1 text-sm text-gray-500">{dashboard.description}</p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
