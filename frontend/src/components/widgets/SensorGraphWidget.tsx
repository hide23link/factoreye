import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useSensorReadings, useSensors } from "../../hooks/queries";
import type { Widget } from "../../types";

export function SensorGraphWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const hours = widget.config.timeRangeHours ?? 1;
  const { data, isLoading } = useSensorReadings(widget.sensorId, hours);
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-400">センサーが設定されていません</p>;
  }
  if (isLoading || !data) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  // 24時間を超える範囲では日付が無いと時刻表示が曖昧になるため出し分ける
  const formatTime = (iso: string) =>
    hours > 24
      ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : new Date(iso).toLocaleTimeString("ja-JP");

  const chartData = [...data.readings]
    .reverse()
    .map((r) => ({ time: formatTime(r.recordedAt), value: r.value }));

  const color = widget.config.color ?? "#2563eb";
  const graphType = widget.config.graphType ?? "line";
  const yDomain: [number | "auto", number | "auto"] = [
    widget.config.yAxisMin ?? "auto",
    widget.config.yAxisMax ?? "auto",
  ];

  return (
    <div className="flex h-full flex-col">
      <p className="mb-1 text-sm font-medium text-gray-700">
        {sensor?.name ?? "センサー"}
        {sensor ? ` (${sensor.unit})` : ""}
      </p>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          {graphType === "bar" ? (
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} />
              <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="value" fill={color} />
            </BarChart>
          ) : graphType === "area" ? (
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} />
              <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
              <Tooltip />
              <Area dataKey="value" stroke={color} fill={color} fillOpacity={0.2} />
            </AreaChart>
          ) : (
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} />
              <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
              <Tooltip />
              <Line type="monotone" dataKey="value" stroke={color} dot={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
