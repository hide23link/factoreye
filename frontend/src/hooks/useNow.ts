import { useEffect, useState } from "react";

/**
 * 現在時刻を、一定間隔で更新して返すフック（既定は 1 秒ごと）。
 *
 * データの有無に関わらず、グラフの横軸（表示ウィンドウ）を時間経過で動かし続けるための
 * 「現在時刻」。polling でデータが更新されなくても、この値だけは一定間隔で進む。
 *
 * 【誰が使うか】TimeRangeControls と、グラフ系の2つのウィジェット（SensorGraphWidget、MultiSensorComparisonWidget）。
 */
export function useNow(intervalMs = 1000): number {
  // 初期値は、画面を開いた時刻。以後は intervalMs ごとに更新する
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
