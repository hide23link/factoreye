/**
 * ダッシュボードのタブ。ヘッダーのすぐ下に 1 行で並べ、押すとそのダッシュボードへ切り替える（PC・スマホ共通）。
 * 左端は「▦ 一覧」（一覧の画面。新しいダッシュボードはここから作る）、続けて全ダッシュボードを一覧と同じ順に並べる。
 * 入りきらないときは折り返さず、横になぞって送る。開いたときは、今のタブが見える位置まで自動で送る。
 * 編集中は薄くして押せなくする（途中で移ると「元に戻す」の履歴が消えるため。「完了」で戻る）。
 * ダッシュボードが 1 つも無いときは出さない。
 *
 * 【誰が使うか】App.tsx の MainShell が、ダッシュボードの画面（一覧・表示）で出す。画面表示モードでは出さない。
 */
import { useEffect, useRef } from "react";

import { useDashboards } from "../hooks/queries";
import { useEditorStore } from "../store/useEditorStore";
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
  const currentRef = useRef<HTMLButtonElement>(null);

  // 今のタブを見える位置まで送る（タブが多くて横に送る必要があるとき）
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedId, dashboards]);

  if (!dashboards || dashboards.length === 0) return null;

  return (
    <nav
      aria-label="ダッシュボードの切り替え"
      className={`flex gap-0.5 overflow-x-auto border-b border-gray-200 bg-white px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${editing ? "pointer-events-none opacity-40" : ""}`}
    >
      <button
        type="button"
        ref={selectedId === null ? currentRef : undefined}
        disabled={editing}
        aria-current={selectedId === null ? "page" : undefined}
        onClick={() => selectDashboard(null)}
        className={`${TAB_CLASS} ${selectedId === null ? ON_CLASS : OFF_CLASS}`}
      >
        ▦ 一覧
      </button>
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
              if (!current) selectDashboard(dashboard.id);
            }}
            className={`${TAB_CLASS} ${current ? ON_CLASS : OFF_CLASS}`}
          >
            {dashboard.name}
          </button>
        );
      })}
    </nav>
  );
}
