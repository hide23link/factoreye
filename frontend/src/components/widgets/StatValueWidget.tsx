import { Line, LineChart, ResponsiveContainer } from "recharts";

import { useSensorReadings, useSensors } from "../../hooks/queries";
import type { Sensor, Widget } from "../../types";

type Severity = "critical" | "warning" | "normal";

// センサー自身の軽故障/重故障しきい値（設定 > センサー管理で編集）に照らして色分けする。
// アラーム側（backend app/alarm_engine.py）と同じ優先順位（重故障を先に判定）
function classifySeverity(value: number, sensor: Sensor): Severity {
  if (sensor.thresholdMaxCritical !== null && value > sensor.thresholdMaxCritical) {
    return "critical";
  }
  if (sensor.thresholdMinCritical !== null && value < sensor.thresholdMinCritical) {
    return "critical";
  }
  if (sensor.thresholdMaxWarning !== null && value > sensor.thresholdMaxWarning) {
    return "warning";
  }
  if (sensor.thresholdMinWarning !== null && value < sensor.thresholdMinWarning) {
    return "warning";
  }
  return "normal";
}

const SEVERITY_STYLE: Record<Severity, { bg: string; text: string; accent: string; label: string }> = {
  critical: { bg: "bg-red-50", text: "text-red-700", accent: "#dc2626", label: "🚨 重故障しきい値超過" },
  warning: { bg: "bg-yellow-50", text: "text-yellow-700", accent: "#ca8a04", label: "⚠️ 軽故障しきい値超過" },
  normal: { bg: "bg-gray-50", text: "text-gray-900", accent: "#2563eb", label: "" },
};

// Grafanaの「Stat」パネルを参考にした、最新値を大きく表示するウィジェット。
// センサーのしきい値に応じて色が変わり、下部に直近の推移（スパークライン）を表示する
export function StatValueWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const hours = widget.config.timeRangeHours ?? 1;
  const { data, isLoading } = useSensorReadings(widget.sensorId, hours);
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-400">センサーが設定されていません</p>;
  }
  if (isLoading || !data || !sensor) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  const latest = data.readings[0];
  const decimals = widget.config.decimals ?? 1;
  const severity = latest ? classifySeverity(latest.value, sensor) : "normal";
  const style = SEVERITY_STYLE[severity];
  const sparklineData = [...data.readings].reverse().map((r) => ({ value: r.value }));

  return (
    <div
      className={`flex h-full flex-col items-center justify-center gap-1 rounded p-2 ${style.bg}`}
    >
      <p className="text-sm font-medium text-gray-600">{sensor.name}</p>
      <p className={`text-4xl font-bold tabular-nums ${style.text}`}>
        {latest ? latest.value.toFixed(decimals) : "—"}
        <span className="ml-1 text-base font-normal text-gray-400">{sensor.unit}</span>
      </p>
      {style.label && <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>}
      {sparklineData.length > 1 && (
        <div className="h-10 w-full max-w-[160px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparklineData}>
              <Line
                type="monotone"
                dataKey="value"
                stroke={style.accent}
                dot={false}
                strokeWidth={1.5}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
