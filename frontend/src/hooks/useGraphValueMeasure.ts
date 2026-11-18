/**
 * グラフの右の今の値の札（GraphValues）を置く高さを入れておく state。
 * グラフの中の GraphValueProbe が測って入れ、GraphValues が読む。同じ値なら入れ直さない（描き直しが続かないように）。
 * 例: const [measure, setMeasure] = useGraphValueMeasure();  → measure は { height: 240, ys: [52, 130] } など
 */
import { useCallback, useState } from "react";

/** グラフの中で測った、札の高さ。height = グラフ全体の高さ、ys = 線ごとの最後の点の高さ（px、グラフの上端から） */
export interface GraphValueMeasure {
  height: number;
  ys: Array<number | undefined>;
}

/** 測った高さを入れる state。同じ値なら入れ直さない（描き直しが続かないように） */
export function useGraphValueMeasure() {
  const [measure, setMeasure] = useState<GraphValueMeasure | undefined>(undefined);
  const update = useCallback((next: GraphValueMeasure) => {
    setMeasure((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);
  return [measure, update] as const;
}
