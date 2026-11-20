/**
 * 「ダッシュボード」設定パネル（設定画面）。新しいダッシュボードを作る入口と、今あるダッシュボードの一覧を出す。
 * 名前を入れて「作成」を押すと、空のダッシュボードを作って、編集モードで開く（名前が空なら「新しいダッシュボード」を連番で付ける）。
 * 今ある名前と同じ名前は作れない（その旨を出す）。一覧の「開く」で、そのダッシュボードを開く。
 * 左のメニューには作成ボタンを置かない（間違えて押しやすいため）。
 * 編集中は、作成も開くも押せない（途中で移ると「元に戻す」の履歴が消えるため。ダッシュボードの画面で「完了」にしてから使う）。
 *
 * 【誰が使うか】SettingsPage.tsx が、「ダッシュボード」のタブで出す。引数（props）はない。
 */
import { useState } from "react";

import { useDashboards } from "../../hooks/queries";
import { useCreateDashboard } from "../../hooks/useCreateDashboard";
import { describeActionError } from "../../lib/errors";
import { useEditorStore } from "../../store/useEditorStore";
import { keepTimeRangeForNextDashboard } from "../../store/useTimeRangeStore";
import { useUiStore } from "../../store/useUiStore";

export function DashboardsSettingsPanel() {
  const { data: dashboards } = useDashboards();
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const editing = useEditorStore((s) => s.editing);
  const [name, setName] = useState("");
  const names = (dashboards ?? []).map((d) => d.name);
  const createMutation = useCreateDashboard(names);
  const trimmed = name.trim();
  const duplicated = trimmed !== "" && names.includes(trimmed);

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <section aria-labelledby="dashboards-create-heading" className="flex flex-col gap-2">
        <h2 id="dashboards-create-heading" className="text-base font-bold text-gray-900">
          新しいダッシュボードを作る
        </h2>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!duplicated) createMutation.mutate(trimmed);
          }}
        >
          <input
            type="text"
            value={name}
            maxLength={100}
            placeholder="名前（空なら「新しいダッシュボード」）"
            aria-label="新しいダッシュボードの名前"
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900"
          />
          <button
            type="submit"
            disabled={editing || createMutation.isPending || !dashboards || duplicated}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            作成
          </button>
        </form>
        {duplicated && (
          <p role="alert" className="text-xs text-red-600">
            同じ名前のダッシュボードがあります。別の名前にしてください。
          </p>
        )}
        {editing && <p className="text-xs text-gray-500">編集中は作れません。ダッシュボードの画面で「完了」を押してから作ってください。</p>}
        {createMutation.isError && (
          <p role="alert" className="text-xs text-red-600">
            {describeActionError(createMutation.error, "ダッシュボードの作成")}
          </p>
        )}
      </section>

      <section aria-labelledby="dashboards-list-heading" className="flex flex-col gap-2">
        <h2 id="dashboards-list-heading" className="text-base font-bold text-gray-900">
          ダッシュボードの一覧
        </h2>
        {dashboards?.length === 0 && <p className="text-sm text-gray-500">まだありません。</p>}
        <ul aria-label="ダッシュボードの一覧" className="flex flex-col divide-y divide-gray-200 rounded border border-gray-200">
          {dashboards?.map((dashboard) => (
            <li key={dashboard.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 truncate text-sm text-gray-900">{dashboard.name}</span>
              <button
                type="button"
                disabled={editing}
                onClick={() => {
                  keepTimeRangeForNextDashboard();
                  selectDashboard(dashboard.id);
                }}
                aria-label={`${dashboard.name}を開く`}
                className="shrink-0 rounded border border-gray-200 px-2.5 py-1 text-sm text-blue-600 hover:bg-gray-100 disabled:opacity-50"
              >
                開く
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
