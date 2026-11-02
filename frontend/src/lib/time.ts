/**
 * グラフの横軸（時刻）の表示文字列を作る。
 *
 * - 表示範囲が 24 時間以下: 時刻だけ（例: 14:05:00）
 * - 24 時間を超える: 日付と時刻（例: 10/4 14:05）。日付が無いと、何日の時刻か分からないため
 *
 * @param ms 表示する時刻（ミリ秒の Unix 時刻）
 * @param timeRangeHours グラフの表示範囲（時間）
 *
 * 【誰が使うか】SensorGraphWidget と MultiSensorComparisonWidget（グラフの横軸の文字）。
 */
export function formatChartTime(ms: number, timeRangeHours: number): string {
  return timeRangeHours > 24
    ? new Date(ms).toLocaleString("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : new Date(ms).toLocaleTimeString("ja-JP");
}

/** 最後の受信を、日本時間の「月/日 時:分」にする。受信がまだなら「まだ受信なし」。 */
export function formatLastReceived(iso: string | null): string {
  if (!iso) return "まだ受信なし";
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
