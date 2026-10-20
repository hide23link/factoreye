/**
 * 編集モードの右の設定パネル。
 * ウィジェットを選んでいれば、そのウィジェットの設定。選んでいなければ、ダッシュボードの名前・説明と「つくりかた」。
 * 変更はすぐ反映して保存する（保存ボタンは無い）。名前と説明は、入力欄を離れたとき（Enter でも）に保存する。
 *
 * 【誰が使うか】DashboardView（編集モードのとき）。
 * 【引数（props）】dashboard = 編集中のダッシュボード。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { deleteDashboard, updateDashboard } from "../../lib/api";
import { describeActionError } from "../../lib/errors";
import { useEditorStore } from "../../store/useEditorStore";
import { useUiStore } from "../../store/useUiStore";
import type { DashboardDetail } from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";
import { Section } from "./controls";
import { WidgetSettings } from "./WidgetSettings";

export function SettingsPanel({ dashboard }: { dashboard: DashboardDetail }) {
  const selectedId = useEditorStore((s) => s.selectedWidgetId);
  const widget = dashboard.widgets.find((w) => w.id === selectedId);
  return widget ? <WidgetSettings key={widget.id} widget={widget} dashboard={dashboard} /> : <DashboardSettings dashboard={dashboard} />;
}

function DashboardSettings({ dashboard }: { dashboard: DashboardDetail }) {
  const queryClient = useQueryClient();
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  // 入力中の値。null は「保存済みの値をそのまま出す」
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (change: { name?: string; description?: string }) => updateDashboard(dashboard.id, change),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboard.id] });
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteDashboard(dashboard.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      selectDashboard(null);
    },
  });

  const commitName = () => {
    const next = (name ?? dashboard.name).trim();
    setName(null);
    // 空にはできない（名前は必須）。元に戻す
    if (next !== "" && next !== dashboard.name) saveMutation.mutate({ name: next });
  };
  const commitDescription = () => {
    const next = description ?? dashboard.description ?? "";
    setDescription(null);
    if (next !== (dashboard.description ?? "")) saveMutation.mutate({ description: next });
  };
  const commitOnEnter = (commit: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") commit();
  };

  return (
    <>
      <div className="flex items-center justify-between border-b border-gray-200 px-3.5 py-3">
        <h3 className="text-[15px] font-bold">ダッシュボードの設定</h3>
        <button
          type="button"
          aria-label="設定パネルを閉じる"
          onClick={() => useEditorStore.getState().setPanelOpen(false)}
          className="h-6 w-6 shrink-0 rounded text-gray-500 hover:bg-gray-100"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-col overflow-auto px-3.5 pb-3.5">
        <Section title="名前">
          <input
            aria-label="名前"
            value={name ?? dashboard.name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={commitOnEnter(commitName)}
            className="w-full rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
          />
        </Section>
        <Section title="説明">
          <input
            aria-label="説明"
            value={description ?? dashboard.description ?? ""}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
            onKeyDown={commitOnEnter(commitDescription)}
            className="w-full rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
          />
          {saveMutation.isError && (
            <p role="alert" className="text-xs text-red-600">
              {describeActionError(saveMutation.error, "ダッシュボードの保存")}
            </p>
          )}
        </Section>
        <Section title="つくりかた">
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-gray-500">
            <li>
              左の<b className="text-gray-900">センサー</b>を、画面にドラッグ（または「＋」）
            </li>
            <li>
              置いたウィジェットを<b className="text-gray-900">クリック</b>すると、ここに設定が出ます
            </li>
            <li>
              <b className="text-gray-900">見出しをつかんで移動</b>、右下をつかんで大きさを変更
            </li>
          </ol>
        </Section>
        <Section title="ダッシュボード">
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="self-start rounded border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
          >
            このダッシュボードを削除
          </button>
          {deleteMutation.isError && (
            <p role="alert" className="text-xs text-red-600">
              {describeActionError(deleteMutation.error, "ダッシュボードの削除")}
            </p>
          )}
        </Section>
      </div>
      {confirmingDelete && (
        <ConfirmDialog
          title="ダッシュボードを削除"
          message="このダッシュボードを削除しますか？置いたウィジェットもすべて見えなくなります。"
          pending={deleteMutation.isPending}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            deleteMutation.mutate();
          }}
        />
      )}
    </>
  );
}
