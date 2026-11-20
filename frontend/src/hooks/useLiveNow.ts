import { resolveRefetchMs } from "../lib/refresh-interval";
import { useRefreshStore } from "../store/useRefreshStore";
import { useNow } from "./useNow";

// 「進めない」ときの useNow の間隔（setInterval の上限 約 24.8 日より短い、実質止まった値）
const NEVER_MS = 2_000_000_000;

/**
 * グラフの「いまの時刻」を、画面の更新間隔の選択に従って進めて返すフック。
 *
 * - 各グラフの設定（既定）: graphMs ごとに進む（今までの useNow と同じ）
 * - 10 秒〜5 分: その間隔で進む
 * - Off: 進まない。「⟳」を押したとき（や選択を変えたとき）だけ、その時刻まで進む
 * 直近モードのグラフは、この時刻から取得の範囲を決める。時刻が進むと新しい範囲の取得が走り、右端が進む。
 *
 * 【誰が使うか】グラフ系のウィジェット、リンクの画面、TimeRangeControls。
 * 【引数】graphMs = 各グラフの設定の間隔（ミリ秒）。
 */
export function useLiveNow(graphMs: number): number {
  const choice = useRefreshStore((s) => s.choice);
  const manualAt = useRefreshStore((s) => s.manualAt);
  const ms = resolveRefetchMs(choice, graphMs);
  const tick = useNow(ms === false ? NEVER_MS : ms);
  return Math.max(tick, manualAt);
}
