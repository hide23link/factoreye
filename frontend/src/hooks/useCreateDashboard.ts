/**
 * 新しいダッシュボードを作って、そのまま編集モードで開く操作。
 * 型の選択は設けず、空のダッシュボードを作る。名前を渡さない（空）ときは、仮の名前を連番で付ける（名前は設定パネルで変えられる）。
 *
 * 【誰が使うか】設定画面の「ダッシュボード」（DashboardsSettingsPanel。名前を渡す）、スマホのタブの「＋」、ダッシュボードが 1 つも無いときの案内（DashboardHome）。
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
    mutationFn: (name?: string) => createDashboard({ name: name?.trim() || nextDashboardName(existingNames) }),
    onSuccess: (dashboard) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      selectDashboard(dashboard.id, { edit: true });
    },
  });
}
