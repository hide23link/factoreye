/**
 * 新しいダッシュボードの名前。既存の名前と重ならないよう、連番を付ける。
 * 「新しいダッシュボード」→「新しいダッシュボード 2」→「新しいダッシュボード 3」…
 *
 * 【誰が使うか】DashboardListPage。
 */
export const NEW_DASHBOARD_NAME = "新しいダッシュボード";

export function nextDashboardName(existing: string[]): string {
  const used = new Set(existing);
  if (!used.has(NEW_DASHBOARD_NAME)) return NEW_DASHBOARD_NAME;
  for (let n = 2; ; n += 1) {
    const candidate = `${NEW_DASHBOARD_NAME} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
