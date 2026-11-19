/**
 * 「ダッシュボード」を開いたときの入口。一覧の画面は無く、ダッシュボードがあれば、最後に見たもの（無ければ先頭）を自動で開く。
 * 切り替えは、左のメニュー（パソコン）か上のタブ（スマホ）で行う。
 * ここに画面が残るのは、読み込み中・取得の失敗・ダッシュボードが 1 つも無いとき（セットアップガイドへの案内と、新規作成）だけ。
 *
 * 【誰が使うか】App.tsx が、ダッシュボードを選んでいないときに出す。引数（props）はない。
 */
import { useEffect } from "react";

import { useCreateDashboard } from "../hooks/useCreateDashboard";
import { useDashboards } from "../hooks/queries";
import { describeActionError } from "../lib/errors";
import { pickDashboardId, readLastDashboardId } from "../lib/last-dashboard";
import { useUiStore } from "../store/useUiStore";
import { ErrorNotice } from "./ErrorNotice";

/** リンクのグラフが見つからなかったときの、黄色の帯（ダッシュボードの画面の上に出す。useUiStore の linkNotFound） */
export function LinkNotFoundNotice() {
  const linkNotFound = useUiStore((s) => s.linkNotFound);
  if (!linkNotFound) return null;
  return (
    <p role="status" className="mx-4 mt-3 rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-800">
      リンクのグラフが見つかりません。消されたか、別のワークスペースのものです。
    </p>
  );
}

export function DashboardHome() {
  const { data: dashboards, isLoading, isError, refetch } = useDashboards();
  const autoSelectDashboard = useUiStore((s) => s.autoSelectDashboard);
  const setView = useUiStore((s) => s.setView);
  const createMutation = useCreateDashboard((dashboards ?? []).map((d) => d.name));

  // 取れたら、最後に見たもの（無ければ先頭）を開く
  useEffect(() => {
    if (!dashboards) return;
    const id = pickDashboardId(
      dashboards.map((d) => d.id),
      readLastDashboardId(),
    );
    if (id !== null) autoSelectDashboard(id);
  }, [dashboards, autoSelectDashboard]);

  return (
    <div className="mx-auto max-w-3xl p-4">
      {(isLoading || (dashboards && dashboards.length > 0)) && <p className="text-sm text-gray-500">読み込み中...</p>}

      {!isLoading && !dashboards && isError && (
        <ErrorNotice message="ダッシュボードの一覧を取得できませんでした。" onRetry={() => void refetch()} />
      )}

      {!isLoading && dashboards?.length === 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="mb-2 text-sm text-blue-900">
            ダッシュボードがまだありません。はじめての方は、5分のセットアップガイドでセンサー登録からダッシュボード表示までを体験できます。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setView("wizard")}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
            >
              セットアップガイドを始める
            </button>
            <button
              type="button"
              disabled={createMutation.isPending}
              onClick={() => createMutation.mutate()}
              className="rounded border border-blue-300 bg-white px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-100 disabled:opacity-50"
            >
              ＋ 新しいダッシュボード
            </button>
          </div>
        </div>
      )}

      {createMutation.isError && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {describeActionError(createMutation.error, "ダッシュボードの作成")}
        </p>
      )}
    </div>
  );
}
