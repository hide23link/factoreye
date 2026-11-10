/**
 * リンクの画面のグラフで、指とマウスの操作を受けるフック。
 *
 * - 上下スワイプ（マウスは上下ドラッグ）: 拡大・縮小。上へ＝短く、下へ＝長く
 * - 2 本指のピンチ・ホイール: 拡大・縮小
 * - 左右ドラッグ: 時間を動かす。右へなぞると過去へ
 * - タップ: その位置の時刻を onTap に渡す。ダブルタップ: onDoubleTap（リンクの設定に戻す）
 * なぞり始め（8px）の向きで左右か上下かを決め、指を離すまで変えない（斜めになっても途中で切り替えない）。
 * 期間の計算は lib/link-range.ts。このフックは、指の動きを計算に渡すだけ。
 *
 * 【誰が使うか】GraphLinkView のグラフの枠。戻り値の ref と handlers を、枠の要素に付ける。
 * 枠には touch-action: none を付ける（ページのスクロールやブラウザの拡大と、指の操作がぶつからないように）。
 */
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { panPeriod, pinchZoom, swipeZoom, zoomPeriod, type LinkPeriod } from "../lib/link-range";

/** なぞり始めの向きを決めるまでの距離（px） */
const LOCK_DISTANCE = 8;
/** 2 回のタップをダブルタップとみなす間隔（ミリ秒） */
const DOUBLE_TAP_MS = 300;
/** ホイール 1 目盛りの倍率 */
const WHEEL_FACTOR = 1.15;

export interface LinkGestureOptions {
  period: LinkPeriod;
  now: number;
  maxMs: number;
  /** 期間が変わったとき。zoomed は拡大・縮小のとき true（長さの表示を出すため） */
  onChange: (period: LinkPeriod, zoomed: boolean) => void;
  /** タップした位置の割合（0 = グラフの左端、1 = 右端） */
  onTap: (ratio: number) => void;
  onDoubleTap: () => void;
}

/** なぞり始めの状態 */
interface Gesture {
  startX: number;
  startY: number;
  period: LinkPeriod;
  direction: "x" | "y" | null;
  moved: boolean;
}

/**
 * グラフの描く範囲（軸の目盛りを除いた所）の左端と幅（px）。
 * 横軸の線（recharts の .recharts-xAxis の線）の位置を使う。見つからなければ枠全体。
 */
export function plotBox(element: HTMLElement): { left: number; width: number } {
  const axisLine = element.querySelector(".recharts-xAxis .recharts-cartesian-axis-line");
  const box = (axisLine ?? element).getBoundingClientRect();
  return { left: box.left, width: box.width };
}

export function useLinkGestures(options: LinkGestureOptions) {
  // 最新の値を、イベントの処理から読めるように保つ（ホイールの登録は要素ごとに 1 回だけにするため）
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const pinch = useRef<{ distance: number; period: LinkPeriod } | null>(null);
  const lastTap = useRef(0);

  const distanceOfPointers = () => {
    const [a, b] = Array.from(pointers.current.values());
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const { period } = latest.current;
    if (pointers.current.size === 1) {
      gesture.current = { startX: e.clientX, startY: e.clientY, period, direction: null, moved: false };
    }
    if (pointers.current.size === 2) {
      pinch.current = { distance: distanceOfPointers(), period };
      if (gesture.current) gesture.current.moved = true;
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const { now, maxMs, onChange } = latest.current;
    if (pointers.current.size >= 2 && pinch.current) {
      onChange(pinchZoom(pinch.current.period, pinch.current.distance, distanceOfPointers(), now, maxMs), true);
      return;
    }
    const current = gesture.current;
    if (!current) return;
    const dx = e.clientX - current.startX;
    const dy = e.clientY - current.startY;
    if (!current.direction && (Math.abs(dx) > LOCK_DISTANCE || Math.abs(dy) > LOCK_DISTANCE)) {
      current.direction = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      current.moved = true;
    }
    if (current.direction === "x") onChange(panPeriod(current.period, dx, plotBox(e.currentTarget).width, now), false);
    if (current.direction === "y") onChange(swipeZoom(current.period, dy, now, maxMs), true);
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const current = gesture.current;
    if (pointers.current.size > 0 || !current) return;
    gesture.current = null;
    // 動かさずに離したときだけ、タップ（2 回続けばダブルタップ）
    if (current.moved || e.type === "pointercancel") return;
    const time = Date.now();
    if (time - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      latest.current.onDoubleTap();
      return;
    }
    lastTap.current = time;
    const box = plotBox(e.currentTarget);
    latest.current.onTap(Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(box.width, 1))));
  };

  // ホイール（PC）: カーソルの位置を保って拡大・縮小する。ページをスクロールさせないよう、passive: false で直接付ける
  const detach = useRef<(() => void) | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!element) return;
    const listener = (event: WheelEvent) => {
      event.preventDefault();
      const { period, now, maxMs, onChange } = latest.current;
      const box = plotBox(element);
      const anchor = Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(box.width, 1)));
      const factor = event.deltaY > 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
      onChange(zoomPeriod(period, period.durationMs * factor, anchor, now, maxMs), true);
    };
    element.addEventListener("wheel", listener, { passive: false });
    detach.current = () => element.removeEventListener("wheel", listener);
  }, []);

  return {
    ref,
    handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
  };
}
