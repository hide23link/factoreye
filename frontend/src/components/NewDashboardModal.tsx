/**
 * 新しいダッシュボードを作る小窓。まず「型」（からっぽ／設備監視／生産管理）を選ぶ。
 * 名前は空欄でもよい（型に応じた名前になる）。作ったら、そのまま編集モードで開く。
 * 型を選ぶと、登録済みのセンサーから種類の合うものを選んで、基本のウィジェットを並べる。
 *
 * 【誰が使うか】DashboardListPage。
 * 【引数（props）】onClose = 閉じるときの処理。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { createPortal } from "react-dom";

import { useSensors } from "../hooks/queries";
import { addWidget, createDashboard } from "../lib/api";
import { DASHBOARD_TEMPLATES, buildTemplateWidgets, type DashboardTemplate } from "../lib/dashboard-templates";
import { describeActionError } from "../lib/errors";
import { useUiStore } from "../store/useUiStore";

export function NewDashboardModal({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const { data: sensors, isLoading: sensorsLoading } = useSensors();
  const [name, setName] = useState("");

  const createMutation = useMutation({
    mutationFn: async (template: DashboardTemplate) => {
      const dashboard = await createDashboard({ name: name.trim() || template.defaultName });
      // ウィジェットは順に作る（途中で失敗したら、そこまでで止めて、作ったダッシュボードは残す）
      for (const widget of buildTemplateWidgets(template.key, sensors ?? [])) {
        await addWidget(dashboard.id, widget);
      }
      return dashboard;
    },
    onSuccess: (dashboard) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      onClose();
      selectDashboard(dashboard.id, { edit: true });
    },
  });

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-xl rounded-xl bg-white p-5 shadow-xl">
        <h2 id={titleId} className="text-lg font-bold">
          新しいダッシュボード
        </h2>
        <p className="text-sm text-gray-500">まず型を選びます。あとから自由に変えられます。</p>

        <label className="mt-3 block text-sm">
          名前（空欄なら型の名前になります）
          <input
            autoFocus
            type="text"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            placeholder="新しいダッシュボード名"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>

        <div className="my-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {DASHBOARD_TEMPLATES.map((template) => (
            <button
              key={template.key}
              type="button"
              disabled={createMutation.isPending || sensorsLoading}
              onClick={() => createMutation.mutate(template)}
              className="rounded-lg border border-gray-200 p-3 text-left hover:border-blue-500 hover:bg-blue-50 disabled:opacity-50"
            >
              <b className="block text-sm">
                {template.title}
                {template.isNew && (
                  <em className="ml-1.5 rounded bg-blue-600 px-1 py-px align-[1px] text-[10px] font-bold not-italic text-white">NEW</em>
                )}
              </b>
              <span className="text-xs text-gray-500">{template.description}</span>
            </button>
          ))}
        </div>

        {createMutation.isError && (
          <p role="alert" className="mb-2 text-xs text-red-600">
            {describeActionError(createMutation.error, "ダッシュボードの作成")}
          </p>
        )}
        <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">
          キャンセル
        </button>
      </div>
    </div>,
    document.body,
  );
}
