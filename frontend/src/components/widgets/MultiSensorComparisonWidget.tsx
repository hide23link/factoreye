import { useQueries } from "@tanstack/react-query";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useSensors } from "../../hooks/queries";
import { fetchSensorReadings } from "../../lib/api";
import type { Widget } from "../../types";

const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];
const POLL_INTERVAL_MS = 5000;

export function MultiSensorComparisonWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const sensorIds = widget.config.sensorIds ?? [];
  const hours = widget.config.timeRangeHours ?? 1;
  const from = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const results = useQueries({
    queries: sensorIds.map((sensorId) => ({
      queryKey: ["readings", sensorId, hours],
      queryFn: () => fetchSensorReadings(sensorId, from),
      refetchInterval: POLL_INTERVAL_MS,
    })),
  });

  if (sensorIds.length === 0) {
    return <p className="text-sm text-gray-400">比較対象のセンサーが設定されていません</p>;
  }

  const formatTime = (iso: string) =>
    hours > 24
      ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : new Date(iso).toLocaleTimeString("ja-JP");

  const seriesByTime = new Map<string, Record<string, number | string>>();
  sensorIds.forEach((sensorId, i) => {
    const readings = results[i]?.data?.readings ?? [];
    for (const r of [...readings].reverse()) {
      const time = formatTime(r.recordedAt);
      const row = seriesByTime.get(time) ?? { time };
      row[sensorId] = r.value;
      seriesByTime.set(time, row);
    }
  });
  const chartData = Array.from(seriesByTime.values());
  const yDomain: [number | "auto", number | "auto"] = [
    widget.config.yAxisMin ?? "auto",
    widget.config.yAxisMax ?? "auto",
  ];

  return (
    <div className="flex h-full flex-col">
      <p className="mb-1 text-sm font-medium text-gray-700">複数センサー比較</p>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} />
            <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {sensorIds.map((sensorId, i) => (
              <Line
                key={sensorId}
                type="monotone"
                dataKey={sensorId}
                name={sensors?.find((s) => s.id === sensorId)?.name ?? sensorId}
                stroke={PALETTE[i % PALETTE.length]}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
