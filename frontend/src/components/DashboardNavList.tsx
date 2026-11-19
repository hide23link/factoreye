/**
 * 左のメニュー（パソコン）の「ダッシュボード」の下に並べる、ダッシュボード名の一覧。
 * 名前を押すとそのダッシュボードへ切り替わり、最後に「＋ 新しいダッシュボード」で空のダッシュボードを作って編集モードで開く。
 * 今見ているダッシュボードに印を付ける（ほかの画面を見ているときは印を付けない）。
 * 編集中は薄くして押せなくする（途中で移ると「元に戻す」の履歴が消えるため。「完了」で戻る）。
 * 移っても、今見ている時間範囲（固定の期間も含む）はそのまま使う。
 *
 * 【誰が使うか】App.tsx の SideRail。スマホは使わず、上のタブ（DashboardTabs）で切り替える。
 */
import { useDashboards } from "../hooks/queries";
import { useCreateDashboard } from "../hooks/useCreateDashboard";
import { describeActionError } from "../lib/errors";
import { useEditorStore } from "../store/useEditorStore";
import { keepTimeRangeForNextDashboard } from "../store/useTimeRangeStore";
import { useUiStore } from "../store/useUiStore";

const ITEM_CLASS = "block w-full truncate rounded-r px-2.5 py-1 text-left text-[13px]";

export function DashboardNavList() {
  const { data: dashboards } = useDashboards();
  const view = useUiStore((s) => s.view);
  const selectedId = useUiStore((s) => s.selectedDashboardId);
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const editing = useEditorStore((s) => s.editing);
  const createMutation = useCreateDashboard((dashboards ?? []).map((d) => d.name));

  return (
    <div className={`mb-1 ml-5 flex flex-col border-l border-gray-200 ${editing ? "opacity-40" : ""}`}>
      <ul aria-label="ダッシュボードの切り替え" className="flex flex-col">
        {dashboards?.map((dashboard) => {
          const current = view === "main" && dashboard.id === selectedId;
          return (
            <li key={dashboard.id}>
              <button
                type="button"
                disabled={editing}
                aria-current={current ? "page" : undefined}
                title={dashboard.name}
                onClick={() => {
                  if (current) return;
                  keepTimeRangeForNextDashboard();
                  selectDashboard(dashboard.id);
                }}
                className={`${ITEM_CLASS} ${
                  current ? "bg-gray-100 font-bold text-gray-900 shadow-[inset_2px_0_0_rgb(var(--blue-600))]" : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                {dashboard.name}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={editing || createMutation.isPending || !dashboards}
        onClick={() => createMutation.mutate()}
        className={`${ITEM_CLASS} text-blue-600 hover:bg-gray-100 disabled:opacity-50`}
      >
        ＋ 新しいダッシュボード
      </button>
      {createMutation.isError && (
        <p role="alert" className="px-2.5 py-1 text-xs text-red-600">
          {describeActionError(createMutation.error, "ダッシュボードの作成")}
        </p>
      )}
    </div>
  );
}
