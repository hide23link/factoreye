import type { ReactNode } from "react";
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
import { useNow } from "../../hooks/useNow";
import { formatChartTime } from "../../lib/time";
import type { Widget } from "../../types";

export function SensorGraphWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  // 「横軸: 直近 N 時間」（WidgetFormModalで設定）がそのまま表示ウィンドウの幅になる
  const hours = widget.config.timeRangeHours ?? 1;
  const { data, isLoading } = useSensorReadings(widget.sensorId, hours);
  const sensor = sensors?.find((s) => s.id === widget.sensorId);
  // 新しいデータが来ていなくても横軸（表示ウィンドウ）を時間経過で動かし続けるための現在時刻
  const now = useNow();

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-400">センサーが設定されていません</p>;
  }
  if (isLoading || !data) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  const windowMs = hours * 60 * 60 * 1000;
  const domain: [number, number] = [now - windowMs, now];
  const formatTime = (ms: number) => formatChartTime(ms, hours);

  const chartData = [...data.readings]
    .reverse()
    .map((r) => ({ time: new Date(r.recordedAt).getTime(), value: r.value }));

  const color = widget.config.color ?? "#2563eb";
  const graphType = widget.config.graphType ?? "line";
  const yDomain: [number | "auto", number | "auto"] = [
    widget.config.yAxisMin ?? "auto",
    widget.config.yAxisMax ?? "auto",
  ];

  const xAxisProps = {
    dataKey: "time",
    type: "number" as const,
    domain,
    tickFormatter: formatTime,
    tick: { fontSize: 10 },
  };
  const tooltipLabelFormatter = (label: ReactNode) => formatTime(Number(label));

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
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
              <Tooltip labelFormatter={tooltipLabelFormatter} />
              <Bar dataKey="value" fill={color} />
            </BarChart>
          ) : graphType === "area" ? (
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
              <Tooltip labelFormatter={tooltipLabelFormatter} />
              <Area dataKey="value" stroke={color} fill={color} fillOpacity={0.2} />
            </AreaChart>
          ) : (
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
              <Tooltip labelFormatter={tooltipLabelFormatter} />
              <Line type="monotone" dataKey="value" stroke={color} dot={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
