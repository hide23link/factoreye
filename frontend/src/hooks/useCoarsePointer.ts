/**
 * 画面の主な入力が「指（タッチ）」かどうか。スマホ・タブレットなら true、マウスのパソコンなら false。
 *
 * 指でグラフの上をなぞると、スクロールのつもりでも数字の吹き出しが出て、画面が動かしにくい。
 * そのため、指の画面ではグラフの「なぞって表示」「なぞって期間選択」をやめ、タップしたときだけ数字を出す。
 *
 * 【誰が使うか】SensorGraphWidget と MultiSensorComparisonWidget が、グラフの操作を切り替える。
 */
import { useEffect, useState } from "react";

const QUERY = "(pointer: coarse)";

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia?.(QUERY).matches === true);
  useEffect(() => {
    const query = window.matchMedia?.(QUERY);
    if (!query) return;
    const onChange = () => setCoarse(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return coarse;
}
