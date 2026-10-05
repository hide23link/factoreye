/**
 * グラフの上で Ctrl（Mac は ⌘）を押しながらホイールを回すと、カーソルの位置を中心に拡大・縮小する
 * （Grafana と同じ操作）。Ctrl・⌘ を押していないホイールは、ふつうのページのスクロールのまま。
 *
 * 戻り値は ref に渡す関数（コールバック ref）。グラフの要素が現れたときに、ホイールの処理を付ける。
 * 読み込み中などで要素が無い間は、何も付けない。
 *
 * カーソルの時刻は getAnchor で返す（useDragSelect の hoverTime）。
 * ホイールのイベントを止めるため、React の onWheel ではなく、要素に直接 passive: false で付ける。
 */
import { useCallback, useEffect, useRef } from "react";

/** ホイール 1 目盛りあたりの倍率。上に回すと拡大（幅が縮む）、下に回すと縮小（幅が広がる） */
const ZOOM_IN = 0.8;
const ZOOM_OUT = 1.25;

export function useCursorZoom(
  getAnchor: () => number | null,
  onZoom: (anchor: number, factor: number) => void,
): (element: HTMLElement | null) => void {
  // 最新の関数を参照できるように保つ（イベントの登録は、要素ごとに 1 回だけにするため）
  const latest = useRef({ getAnchor, onZoom });
  useEffect(() => {
    latest.current = { getAnchor, onZoom };
  });

  // 登録を外す関数（要素が変わったとき、または外れたときに使う）
  const detach = useRef<(() => void) | null>(null);

  return useCallback((element: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!element) return;

    const listener = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const anchor = latest.current.getAnchor();
      if (anchor === null) return;
      event.preventDefault();
      latest.current.onZoom(anchor, event.deltaY < 0 ? ZOOM_IN : ZOOM_OUT);
    };
    element.addEventListener("wheel", listener, { passive: false });
    detach.current = () => element.removeEventListener("wheel", listener);
  }, []);
}
