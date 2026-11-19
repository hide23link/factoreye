/**
 * 新しいダッシュボードを作って、そのまま編集モードで開く操作。
 * 型の選択は設けず、名前だけ仮に付けた空のダッシュボードを作る（名前は設定パネルで変えられる）。
 *
 * 【誰が使うか】左のメニューの「＋ 新しいダッシュボード」、スマホのタブの「＋」、ダッシュボードが 1 つも無いときの案内（DashboardHome）。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createDashboard } from "../lib/api";
import { nextDashboardName } from "../lib/dashboard-name";
import { useUiStore } from "../store/useUiStore";

/** existingNames = 今あるダッシュボードの名前（連番で重ならない名前を付けるため） */
export function useCreateDashboard(existingNames: string[]) {
  const queryClient = useQueryClient();
  const selectDashboard = useUiStore((s) => s.selectDashboard);
  return useMutation({
    mutationFn: () => createDashboard({ name: nextDashboardName(existingNames) }),
    onSuccess: (dashboard) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      selectDashboard(dashboard.id, { edit: true });
    },
  });
}
