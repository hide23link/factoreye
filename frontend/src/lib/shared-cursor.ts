/**
 * ふつうのグラフ・複数のグラフの上でマウスを動かしたとき（指ならタップ・ドラッグ）に、全グラフ共有のカーソルの時刻
 * （store/useCursorTimeStore.ts）を更新するための、グラフ（Recharts）のイベントを作る。
 *
 * 【誰が使うか】SensorGraphWidget・MultiSensorComparisonWidget。
 */
import { requestCursorTime } from "../store/useCursorTimeStore";

/** Recharts のグラフのイベントの引数（横軸の値＝時刻が activeLabel に入る） */
export interface ChartEventState {
  activeLabel?: string | number;
}

/**
 * グラフの上でマウスを動かしたとき（指ならタップ・ドラッグ）に、共有のカーソルの時刻を更新するイベントを、元のイベントに足す。
 * マウスがグラフの外に出ても、カーソルはその位置に残す（勝手に今へ戻さない）。
 * 時刻は、グラフの 1 区間（stepMs）に丸めて、次の描画の 1 回にまとめて入れる。
 * 【引数】enabled = false のとき（リンクの画面）は、元のイベントをそのまま返す。stepMs = グラフの 1 区間の長さ（ミリ秒）。
 * base = 元のイベント（ドラッグで期間を選ぶ onMouseMove など。マウスの移動では、元のイベントも呼ぶ）。
 * 例: <LineChart {...withSharedCursor(true, 60_000, drag.handlers)}>
 */
export function withSharedCursor<T extends { onMouseMove?: (state: ChartEventState | undefined) => void }>(
  enabled: boolean,
  stepMs: number,
  base: T,
): T & { onMouseMove?: (state: ChartEventState | undefined) => void; onClick?: (state: ChartEventState | undefined) => void; onTouchMove?: (state: ChartEventState | undefined) => void } {
  if (!enabled) return base;
  const update = (state: ChartEventState | undefined) => {
    if (state?.activeLabel === undefined) return;
    const time = Number(state.activeLabel);
    if (Number.isFinite(time)) requestCursorTime(time, stepMs);
  };
  return {
    ...base,
    onMouseMove: (state) => {
      base.onMouseMove?.(state);
      update(state);
    },
    onClick: update,
    onTouchMove: update,
  };
}
