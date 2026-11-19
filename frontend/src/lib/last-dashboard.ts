/**
 * 最後に見たダッシュボードの ID を、この端末のブラウザ（localStorage）に覚える。
 * 一覧の画面をなくしたので、「ダッシュボード」を開いたときは、最後に見たもの（無ければ先頭）を出す。
 * localStorage が使えない（プライベートウィンドウなど）ときは、覚えないだけで動く。
 *
 * 【誰が使うか】useUiStore（選んだときに書く）、DashboardHome（開くものを決める）。
 */
const KEY = "factoreye.lastDashboardId";

/** 最後に見たダッシュボードの ID。覚えていない・読めないときは null */
export function readLastDashboardId(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** 最後に見たダッシュボードを覚える。null なら忘れる（消されたダッシュボードを開き続けないため） */
export function writeLastDashboardId(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, id);
  } catch {
    // 覚えられなくても、画面は動く
  }
}

/**
 * 開くダッシュボードを決める。最後に見たものが今もあればそれ、無ければ先頭。1 つも無ければ null。
 * 例: pickDashboardId(["a", "b"], "b") → "b"、pickDashboardId(["a", "b"], "x") → "a"、pickDashboardId([], "a") → null
 */
export function pickDashboardId(ids: string[], lastId: string | null): string | null {
  if (lastId !== null && ids.includes(lastId)) return lastId;
  return ids[0] ?? null;
}
