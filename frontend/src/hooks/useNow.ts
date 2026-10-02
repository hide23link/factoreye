import { useEffect, useState } from "react";

// データの有無に関わらずグラフの横軸（表示ウィンドウ）を時間経過で動かし続けるための
// 「現在時刻」。pollingでデータが更新されなくても、この値だけは一定間隔で進む。
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
