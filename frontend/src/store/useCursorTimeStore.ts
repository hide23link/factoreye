/**
 * グラフのカーソルの時刻を、同じダッシュボードのすべてのグラフで共有する置き場。
 * 1 つのグラフでカーソルを動かすと、計器グラフ（TrendStack）の全行・ふつうのグラフ（SensorGraph）・複数のグラフ
 * （MultiSensorComparison）の縦線が、同じ時刻に動く。
 *
 * time が null のときは、利用者がまだ動かしていない（または「今に戻す」を押した）状態で、各グラフは「現在位置」＝表示範囲の右端に出す。
 * 直近の表示では右端が今なので、時間が進んでも今に追従する。利用者が動かしたあとは、その時刻に固定する（勝手に今へ戻さない）。
 * （各行の、その時刻の値の一覧は、計器グラフごとに useTrendCursorStore が持つ。ここは時刻だけ）
 *
 * マウスを動かすたびに全グラフを描き直さないよう、時刻の更新は requestCursorTime で、次の描画の 1 回にまとめて、
 * グラフの 1 区間に丸めてから入れる。
 *
 * 【誰が使うか】TrendStackWidget・SensorGraphWidget・MultiSensorComparisonWidget（SharedCursor.tsx）。
 * DashboardView が、ダッシュボードを閉じるときに reset する（次に開いたときは「今」から）。リンクの画面は使わない（リンクが時刻を持つ）。
 * 例: time = 1763400000000（利用者が動かした時刻）、または null（今に追従）
 *
 * owner は、カーソルを動かしたグラフ（ウィジェット）の ID。「今に戻す」の札とボタンは、動かしたグラフにだけ出し、
 * ほかのグラフの見出しはすっきりさせる（縦線は全グラフで連動のまま）。owner が null（不明）のときは、どのグラフにも出す。
 */
import { create } from "zustand";

interface CursorTimeState {
  /** カーソルの時刻（ミリ秒）。null は「現在位置（表示範囲の右端）」 */
  time: number | null;
  /** カーソルを動かしたグラフ（ウィジェット）の ID。null は不明（どのグラフにも「今に戻す」を出す） */
  owner: string | null;
  setTime: (time: number, owner?: string | null) => void;
  /** 「今に戻す」。時刻を null にして、今に追従する状態に戻す */
  reset: () => void;
}

export const useCursorTimeStore = create<CursorTimeState>((set) => ({
  time: null,
  owner: null,
  setTime: (time, owner = null) =>
    set((state) => (state.time === time && state.owner === owner ? state : { time, owner })),
  reset: () => {
    cancelPendingCursorTime();
    set((state) => (state.time === null ? state : { time: null, owner: null }));
  },
}));

// 次の描画に入れる時刻と、その予約（1 つだけ。新しい時刻が来たら、時刻だけ入れ替える）
let pendingTime: number | null = null;
let pendingOwner: string | null = null;
let pendingHandle: number | null = null;

function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

/**
 * カーソルの時刻を、次の描画の 1 回にまとめて入れる（マウス移動のたびに全グラフを描き直さないため）。
 * stepMs を渡すと、その幅（グラフの 1 区間）に丸める。owner は動かしたグラフの ID。
 * 例: requestCursorTime(1000_000 + 400, 1000, "w1") → 次の描画で time が 1000000、owner が "w1" になる
 */
export function requestCursorTime(time: number, stepMs = 0, owner: string | null = null): void {
  pendingTime = stepMs > 0 ? Math.round(time / stepMs) * stepMs : time;
  pendingOwner = owner;
  if (pendingHandle !== null) return;
  pendingHandle = scheduleFrame(() => {
    pendingHandle = null;
    if (pendingTime === null) return;
    const next = pendingTime;
    pendingTime = null;
    useCursorTimeStore.getState().setTime(next, pendingOwner);
  });
}

/** 予約した時刻の更新を取り消す（「今に戻す」のあとに、遅れて古い時刻が入らないように） */
export function cancelPendingCursorTime(): void {
  pendingTime = null;
  if (pendingHandle !== null) {
    cancelFrame(pendingHandle);
    pendingHandle = null;
  }
}
