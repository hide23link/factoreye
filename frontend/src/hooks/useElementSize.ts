import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * 要素の実際の大きさ（px）を返すフック。大きさが変わるたびに更新する。
 *
 * ウィジェットは、ユーザーが自由に大きさを変えられる。中身を「大きさに合わせて」描くには、
 * 画面の幅などからの計算ではなく、その要素の実寸を使うのが確実なため。
 * ResizeObserver が無い環境（テストなど）では、0 のまま。
 *
 * 【誰が使うか】ProductionPlanWidget、DashboardView（ドロップ位置の計算）。
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
