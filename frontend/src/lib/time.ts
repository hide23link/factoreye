// グラフ横軸（時間）表示用のフォーマッタ。24時間を超える範囲では日付が無いと
// 時刻表示が曖昧になるため、timeRangeHoursに応じて出し分ける。
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
