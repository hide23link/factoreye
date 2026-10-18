/**
 * グラフ上で時間をドラッグして、その期間を選ぶためのフック（Grafana のドラッグ拡大と同じ操作）。
 *
 * 横軸が時刻（ミリ秒）の折れ線・棒・面グラフで使う。マウスを押した位置から離した位置までを、
 * 選択の範囲として onSelect に渡す。離したときの幅が短すぎる（1 秒未満）場合は、選択しない。
 *
 * 【誰が使うか】SensorGraphWidget と MultiSensorComparisonWidget が、グラフに付ける。
 */
import { useRef, useState } from "react";

/** Recharts のマウスイベントの一部（横軸の値が activeLabel に入る） */
interface ChartPointerState {
  activeLabel?: string | number;
}

/** 1 秒未満の選択は、誤操作として無視する */
const MIN_SELECTION_MS = 1000;

export function useDragSelect(onSelect: (from: number, to: number) => void) {
  const [anchor, setAnchor] = useState<number | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  // マウスが今ある位置の時刻（ドラッグしていなくても追う）。カーソル位置の拡大・縮小に使う
  const hoverRef = useRef<number | null>(null);

  const timeOf = (state: ChartPointerState | undefined): number | null => {
    const value = Number(state?.activeLabel);
    return Number.isFinite(value) ? value : null;
  };

  return {
    /** 選択中の範囲（描画用）。選択していなければ null */
    selection:
      anchor !== null && current !== null
        ? { x1: Math.min(anchor, current), x2: Math.max(anchor, current) }
        : null,
    /** マウスが今ある位置の時刻。グラフの外（または一度も動いていない）なら null */
    hoverTime: (): number | null => hoverRef.current,
    handlers: {
      onMouseDown: (state: ChartPointerState | undefined) => {
        const time = timeOf(state);
        if (time === null) return;
        setAnchor(time);
        setCurrent(time);
      },
      onMouseMove: (state: ChartPointerState | undefined) => {
        const time = timeOf(state);
        hoverRef.current = time;
        if (anchor === null) return;
        if (time !== null) setCurrent(time);
      },
      onMouseUp: () => {
        if (anchor !== null && current !== null && Math.abs(current - anchor) >= MIN_SELECTION_MS) {
          onSelect(Math.min(anchor, current), Math.max(anchor, current));
        }
        setAnchor(null);
        setCurrent(null);
      },
      onMouseLeave: () => {
        hoverRef.current = null;
        setAnchor(null);
        setCurrent(null);
      },
    },
  };
}
