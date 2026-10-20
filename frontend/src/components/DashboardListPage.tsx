/**
 * ダッシュボードの一覧画面。ミニプレビューつきのカードで一覧し、「新しいダッシュボード」で空のダッシュボードを作って、そのまま編集モードで開く。
 * 1つもまだ無いときは、セットアップガイドへの案内を出す。
 *
 * 【誰が使うか】App.tsx が、ダッシュボードを選んでいないときに出す。引数（props）はない。
 */
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";

import { useDashboards } from "../hooks/queries";
import { createDashboard, fetchDashboard } from "../lib/api";
import { nextDashboardName } from "../lib/dashboard-name";
import { describeActionError } from "../lib/errors";
import { useUiStore } from "../store/useUiStore";
import type { Widget } from "../types";
import { ErrorNotice } from "./ErrorNotice";

// プレビューの 1 行の高さ（px）。実際の格子の縮尺ではなく、配置の雰囲気が分かればよい
const THUMB_ROW_PX = 6;
const THUMB_COLUMNS = 12;

/** 種類ごとのプレビューの色（生産管理は緑、アラームは赤、そのほかは青） */
function thumbTone(type: Widget["type"]): string {
  if (type === "ProductionPlan") return "border-green-600 bg-green-100";
  if (type === "AlarmAlert") return "border-red-600 bg-red-100";
  return "border-blue-600 bg-blue-100";
}

/** ウィジェットの配置を、小さな四角で見せる。ウィジェットを取得できていないときは空のまま */
function DashboardThumb({ widgets }: { widgets: Widget[] | undefined }) {
  return (
    <div aria-hidden="true" className="relative h-[130px] overflow-hidden border-b border-gray-200 bg-gray-50">
      {widgets?.map((w) => (
        <i
          key={w.id}
          className={`absolute rounded-sm border ${thumbTone(w.type)}`}
          style={{
            left: `${((w.gridColumn - 1) / THUMB_COLUMNS) * 100 + 0.6}%`,
            top: (w.gridRow - 1) * THUMB_ROW_PX + 4,
            width: `${(w.gridWidth / THUMB_COLUMNS) * 100 - 1.2}%`,
            height: w.gridHeight * THUMB_ROW_PX - 2,
          }}
        />
      ))}
    </div>
  );
}

/** ダッシュボードの一覧（カードと、新規作成）。 */
export function DashboardListPage() {
  const { data: dashboards, isLoading, isError, refetch } = useDashboards();
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const setView = useUiStore((s) => s.setView);
  const queryClient = useQueryClient();

  // 型の選択は設けず、名前だけ仮に付けた空のダッシュボードを作って、編集モードで開く（名前は設定パネルで変えられる）
  const createMutation = useMutation({
    mutationFn: () => createDashboard({ name: nextDashboardName((dashboards ?? []).map((d) => d.name)) }),
    onSuccess: (dashboard) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      selectDashboard(dashboard.id, { edit: true });
    },
  });

  // プレビュー用に、各ダッシュボードのウィジェットを取る（一覧の API には含まれないため）。
  // 5 秒ごとの取り直しはしない（一覧を開いている間に配置が変わることは少ない）
  const details = useQueries({
    queries: (dashboards ?? []).map((d) => ({
      queryKey: ["dashboard", d.id],
      queryFn: () => fetchDashboard(d.id),
      staleTime: 30_000,
    })),
  });

  return (
    <div className="mx-auto max-w-5xl p-4">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">ダッシュボード一覧</h1>

      {isLoading && <p className="text-sm text-gray-400">読み込み中...</p>}

      {!isLoading && !dashboards && isError && (
        <ErrorNotice message="ダッシュボードの一覧を取得できませんでした。" onRetry={() => void refetch()} />
      )}

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

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {dashboards?.map((dashboard, index) => {
          const widgets = details[index]?.data?.widgets;
          return (
            <button
              key={dashboard.id}
              type="button"
              onClick={() => selectDashboard(dashboard.id)}
              className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-left shadow-sm hover:border-blue-400 hover:shadow"
            >
              <DashboardThumb widgets={widgets} />
              <span className="px-3 py-2.5">
                <span className="block font-semibold text-gray-900">{dashboard.name}</span>
                <span className="text-xs text-gray-500">
                  {dashboard.description ?? ""}
                  {widgets !== undefined && `${dashboard.description ? "　・　" : ""}ウィジェット ${widgets.length}`}
                </span>
              </span>
            </button>
          );
        })}
        {!isLoading && (
          <button
            type="button"
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
            className="flex min-h-[200px] flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-gray-300 font-semibold text-gray-500 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50"
          >
            <span aria-hidden="true" className="text-3xl leading-none">
              ＋
            </span>
            新しいダッシュボード
          </button>
        )}
      </div>

      {createMutation.isError && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {describeActionError(createMutation.error, "ダッシュボードの作成")}
        </p>
      )}
    </div>
  );
}
