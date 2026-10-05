/**
 * 複数のセンサーの値を、1つのグラフに重ねて比較するウィジェット。
 *
 * 表示する時間範囲は、ダッシュボードで 1 つだけ持つ（useTimeRangeStore）。
 * センサーごとに間引いたデータを取り（useQueries）、区間の開始時刻をそろえて1本の表にしてから描く。
 * 同じ範囲・同じ区間数で取るので、時間軸はすべてのセンサーで一致する。
 */
import { useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useSensors } from "../../hooks/queries";
import { useDragSelect } from "../../hooks/useDragSelect";
import { useNow } from "../../hooks/useNow";
import { fetchSensorReadingsDownsampled } from "../../lib/api";
import { formatChartTime } from "../../lib/time";
import { absoluteRange, resolveRange, spanHours } from "../../lib/timeRange";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import type { Widget } from "../../types";
import { GRAPH_BUCKETS } from "./SensorGraphWidget";

// センサーごとの線の色（順番に使う。足りなくなったら最初から繰り返す）
const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];
// 直近モードで取り直す間隔（ミリ秒）
const POLL_INTERVAL_MS = 5000;

/** 複数センサーの比較グラフ。比較するセンサーは widget.config.sensorIds で決まる。 */
export function MultiSensorComparisonWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const sensorIds = widget.config.sensorIds ?? [];
  const range = useTimeRangeStore((s) => s.range);
  const setRange = useTimeRangeStore((s) => s.setRange);
  // 直近モードでは、データが来なくても横軸（表示範囲）を時間経過で動かし続ける
  const now = useNow();
  const bounds = resolveRange(range, now);
  const live = range.mode === "relative";
  const drag = useDragSelect((from, to) => {
    const next = absoluteRange(from, to);
    if (next) setRange(next);
  });

  // 範囲・区間数は、ウィジェットの取得と同じ queryKey の形にする（グラフ用の取得を共有する）
  const results = useQueries({
    queries: sensorIds.map((sensorId) => ({
      queryKey: [
        "readings-downsampled",
        sensorId,
        Math.round(bounds.from / 1000),
        Math.round(bounds.to / 1000),
        GRAPH_BUCKETS,
      ],
      queryFn: () =>
        fetchSensorReadingsDownsampled(
          sensorId,
          new Date(bounds.from).toISOString(),
          new Date(bounds.to).toISOString(),
          GRAPH_BUCKETS,
        ),
      refetchInterval: live ? POLL_INTERVAL_MS : false,
    })),
  });

  if (sensorIds.length === 0) {
    return <p className="text-sm text-gray-400">比較対象のセンサーが設定されていません</p>;
  }

  const hours = spanHours(range, now);
  const formatTime = (ms: number) => formatChartTime(ms, hours);

  // 区間の開始時刻ごとに、各センサーの平均を1行にまとめる（同じ区間は同じ行に入る）
  const seriesByTime = new Map<number, Record<string, number>>();
  sensorIds.forEach((sensorId, i) => {
    const data = results[i]?.data;
    const halfBucketMs = ((data?.bucketSeconds ?? 0) * 1000) / 2;
    for (const b of data?.buckets ?? []) {
      const time = new Date(b.start).getTime() + halfBucketMs;
      const row = seriesByTime.get(time) ?? { time };
      row[sensorId] = b.avg;
      seriesByTime.set(time, row);
    }
  });
  const chartData = Array.from(seriesByTime.values()).sort((a, b) => a.time - b.time);
  const yDomain: [number | "auto", number | "auto"] = [
    widget.config.yAxisMin ?? "auto",
    widget.config.yAxisMax ?? "auto",
  ];

  return (
    <div className="flex h-full flex-col">
      <p className="mb-1 text-sm font-medium text-gray-700">複数センサー比較</p>
      <div className="min-h-0 flex-1 select-none">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} {...drag.handlers}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              type="number"
              domain={[bounds.from, bounds.to]}
              tickFormatter={formatTime}
              tick={{ fontSize: 10 }}
            />
            <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
            <Tooltip labelFormatter={(label: ReactNode) => formatTime(Number(label))} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {sensorIds.map((sensorId, i) => (
              <Line
                key={sensorId}
                type="monotone"
                dataKey={sensorId}
                name={sensors?.find((s) => s.id === sensorId)?.name ?? sensorId}
                stroke={PALETTE[i % PALETTE.length]}
                dot={false}
                // 各センサーの区間は時刻が揃わないことが多いため（= 行のほとんどは自分の値が無い）、
                // connectNulls が無いと線が途切れてしまう。常に true にして、自分の点だけを繋ぐ
                connectNulls
              />
            ))}
            {drag.selection && <ReferenceArea x1={drag.selection.x1} x2={drag.selection.x2} />}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
