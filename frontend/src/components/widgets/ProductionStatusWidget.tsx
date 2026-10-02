import { useSensorReadings, useSensorReadingsAggregate, useSensors } from "../../hooks/queries";
import type { Widget } from "../../types";

// queryKeyが毎レンダー変わって無駄に再フェッチされないよう、分単位に丸めた境界を使う
// （「直近1時間」「本日累計」は数十秒のズレが出ても実用上問題にならない）
function startOfCurrentMinute(offsetMs = 0): string {
  const d = new Date(Date.now() - offsetMs);
  d.setSeconds(0, 0);
  return d.toISOString();
}

function startOfTodayLocal(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function ProductionStatusWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const { data, isLoading } = useSensorReadings(widget.sensorId, 1);
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  const lastHourFrom = startOfCurrentMinute(60 * 60 * 1000);
  const todayFrom = startOfTodayLocal();
  const { data: lastHour } = useSensorReadingsAggregate(widget.sensorId, lastHourFrom);
  const { data: today } = useSensorReadingsAggregate(widget.sensorId, todayFrom);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-400">センサーが設定されていません</p>;
  }
  if (isLoading || !data) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  const latest = data.readings[0];
  const threshold = widget.config.onThreshold ?? 0;
  const isRunning = latest !== undefined && latest.value > threshold;
  const dailyTarget = widget.config.dailyTarget;
  const achievementRate =
    dailyTarget && dailyTarget > 0 && today ? (today.sum / dailyTarget) * 100 : null;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <p className="text-sm font-medium text-gray-700">{sensor?.name ?? "センサー"}</p>
      <span
        className={`rounded-full px-4 py-2 text-lg font-bold ${
          isRunning ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"
        }`}
      >
        {isRunning ? "稼働中" : "停止中"}
      </span>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-center text-xs text-gray-500">
        <div>
          <p className="text-base font-semibold text-gray-800">
            {lastHour ? Math.round(lastHour.sum) : "—"}
          </p>
          <p>直近1時間 {sensor?.unit}</p>
        </div>
        <div>
          <p className="text-base font-semibold text-gray-800">
            {today ? Math.round(today.sum) : "—"}
          </p>
          <p>本日累計 {sensor?.unit}</p>
        </div>
      </div>

      {achievementRate !== null && (
        <p className="text-xs text-gray-400">
          目標達成率: {achievementRate.toFixed(0)}%（目標 {dailyTarget}
          {sensor?.unit}）
        </p>
      )}
    </div>
  );
}
