/**
 * ダッシュボードのタブ。ヘッダーのすぐ下に 1 行で並べ、押すとそのダッシュボードへ切り替える。スマホだけで出す
 * （パソコンは左のメニューにダッシュボード名を並べる。DashboardNavList）。一覧の画面は無い。
 * 全ダッシュボードを並べ、右端の「＋」で新しいダッシュボードを作る。
 * 入りきらないときは折り返さず、横になぞって送る。開いたときは、今のタブが見える位置まで自動で送る。
 * 編集中は薄くして押せなくする（途中で移ると「元に戻す」の履歴が消えるため。「完了」で戻る）。
 * 移っても、今見ている時間範囲（固定の期間も含む）はそのまま使う。
 * ダッシュボードが 1 つも無いときは出さない。
 *
 * 【誰が使うか】App.tsx の MainShell が、ダッシュボードの画面で出す。画面表示モードでは出さない。
 */
import { useEffect, useRef } from "react";

import { useDashboards } from "../hooks/queries";
import { useCreateDashboard } from "../hooks/useCreateDashboard";
import { useEditorStore } from "../store/useEditorStore";
import { keepTimeRangeForNextDashboard } from "../store/useTimeRangeStore";
import { useUiStore } from "../store/useUiStore";

const TAB_CLASS = "shrink-0 whitespace-nowrap border-b-[3px] px-3.5 pb-2 pt-2.5 text-sm";
const ON_CLASS = "border-blue-600 font-bold text-blue-700";
const OFF_CLASS = "border-transparent text-gray-500 hover:text-gray-900";

/** ダッシュボードのタブの行。 */
export function DashboardTabs() {
  const { data: dashboards } = useDashboards();
  const selectedId = useUiStore((s) => s.selectedDashboardId);
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  const editing = useEditorStore((s) => s.editing);
  const navRef = useRef<HTMLElement>(null);
  const currentRef = useRef<HTMLButtonElement>(null);
  const idsKey = dashboards?.map((d) => d.id).join(",");
  const createMutation = useCreateDashboard((dashboards ?? []).map((d) => d.name));

  // 今のタブを見える位置まで、横にだけ送る（scrollIntoView はページも縦に動かすので使わない）。
  // 名前の変更などで取り直しただけのときは動かさない（並びと選択が変わったときだけ）
  useEffect(() => {
    const nav = navRef.current;
    const tab = currentRef.current;
    if (!nav || !tab) return;
    const tabRight = tab.offsetLeft + tab.offsetWidth;
    if (tab.offsetLeft < nav.scrollLeft) nav.scrollLeft = tab.offsetLeft;
    else if (tabRight > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = tabRight - nav.clientWidth;
  }, [selectedId, idsKey]);

  if (!dashboards || dashboards.length === 0) return null;

  return (
    <nav
      ref={navRef}
      aria-label="ダッシュボードの切り替え"
      className={`relative flex gap-0.5 overflow-x-auto border-b sm:hidden border-gray-200 bg-white px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${editing ? "opacity-40" : ""}`}
    >
      {dashboards.map((dashboard) => {
        const current = dashboard.id === selectedId;
        return (
          <button
            key={dashboard.id}
            type="button"
            ref={current ? currentRef : undefined}
            disabled={editing}
            aria-current={current ? "page" : undefined}
            onClick={() => {
              if (current) return;
              keepTimeRangeForNextDashboard();
              selectDashboard(dashboard.id);
            }}
            className={`${TAB_CLASS} ${current ? ON_CLASS : OFF_CLASS}`}
          >
            {dashboard.name}
          </button>
        );
      })}
      <button
        type="button"
        disabled={editing || createMutation.isPending}
        onClick={() => createMutation.mutate()}
        aria-label="新しいダッシュボード"
        className={`${TAB_CLASS} border-transparent text-blue-600 disabled:opacity-50`}
      >
        ＋
      </button>
    </nav>
  );
}
