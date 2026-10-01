import { useSensorReadings, useSensors } from "../../hooks/queries";
import type { Widget } from "../../types";

export function ProductionStatusWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const { data, isLoading } = useSensorReadings(widget.sensorId, "1h");
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-400">センサーが設定されていません</p>;
  }
  if (isLoading || !data) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  const latest = data.readings[0];
  const threshold = widget.config.onThreshold ?? 0;
  const isRunning = latest !== undefined && latest.value > threshold;

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
      {latest && (
        <p className="text-xs text-gray-400">
          最終値: {latest.value} {sensor?.unit}
        </p>
      )}
    </div>
  );
}
