/**
 * 1センサーの測定値を、折れ線・棒・面グラフで表示するウィジェット。
 *
 * 表示する時間範囲は、ダッシュボードで 1 つだけ持つ（useTimeRangeStore）。
 * 範囲が長くても重くならないよう、生データではなく間引いたデータ（区間ごとの平均）を描く。
 * グラフ上でドラッグすると、その期間に拡大する。
 */
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useDownsampledReadings, useSensors } from "../../hooks/queries";
import { useCursorZoom } from "../../hooks/useCursorZoom";
import { useDragSelect } from "../../hooks/useDragSelect";
import { useNow } from "../../hooks/useNow";
import { formatChartTime } from "../../lib/time";
import {
  absoluteRange,
  maxRangeForBuild,
  resolveRange,
  spanHours,
  zoomAround,
} from "../../lib/timeRange";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import type { Widget } from "../../types";

/** グラフの区間数（表示の横幅に合わせた本数の目安。API の上限は 1000） */
export const GRAPH_BUCKETS = 500;

/** センサーのグラフ。設定（色・グラフの種類・Y 軸の範囲）は widget.config に入っている。 */
export function SensorGraphWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const range = useTimeRangeStore((s) => s.range);
  const setRange = useTimeRangeStore((s) => s.setRange);
  // 直近モードでは、データが来なくても横軸（表示範囲）を時間経過で動かし続ける
  const now = useNow();
  const bounds = resolveRange(range, now);
  const { data, isLoading } = useDownsampledReadings(
    widget.sensorId,
    bounds,
    GRAPH_BUCKETS,
    range.mode === "relative",
  );
  const drag = useDragSelect((from, to) => {
    const next = absoluteRange(from, to);
    if (next) setRange(next);
  });
  // Ctrl（⌘）＋ホイールで、カーソルの時刻を中心に拡大・縮小する
  const chartRef = useCursorZoom(drag.hoverTime, (anchor, factor) =>
    setRange(zoomAround(range, anchor, factor, now, maxRangeForBuild())),
  );
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-400">センサーが設定されていません</p>;
  }
  if (isLoading || !data) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  const hours = spanHours(range, now);
  const formatTime = (ms: number) => formatChartTime(ms, hours);

  // 区間の中央の時刻に、区間の平均を置く（区間の幅の半分ずらす）
  const halfBucketMs = (data.bucketSeconds * 1000) / 2;
  const chartData = data.buckets.map((b) => ({
    time: new Date(b.start).getTime() + halfBucketMs,
    value: b.avg,
  }));

  const color = widget.config.color ?? "#2563eb";
  const graphType = widget.config.graphType ?? "line";
  const yDomain: [number | "auto", number | "auto"] = [
    widget.config.yAxisMin ?? "auto",
    widget.config.yAxisMax ?? "auto",
  ];

  // 横軸の共通の設定（時刻の数値を、表示用の文字列に変換する）
  const xAxisProps = {
    dataKey: "time",
    type: "number" as const,
    domain: [bounds.from, bounds.to] as [number, number],
    tickFormatter: formatTime,
    tick: { fontSize: 10 },
  };
  const tooltipLabelFormatter = (label: ReactNode) => formatTime(Number(label));
  const selection = drag.selection;

  return (
    <div className="flex h-full flex-col">
      <p className="mb-1 text-sm font-medium text-gray-700">
        {sensor?.name ?? "センサー"}
        {sensor ? ` (${sensor.unit})` : ""}
      </p>
      <div ref={chartRef} className="min-h-0 flex-1 select-none">
        <ResponsiveContainer width="100%" height="100%">
          {graphType === "bar" ? (
            <BarChart data={chartData} {...drag.handlers}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
              <Tooltip labelFormatter={tooltipLabelFormatter} />
              <Bar dataKey="value" fill={color} />
              {selection && <ReferenceArea x1={selection.x1} x2={selection.x2} />}
            </BarChart>
          ) : graphType === "area" ? (
            <AreaChart data={chartData} {...drag.handlers}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
              <Tooltip labelFormatter={tooltipLabelFormatter} />
              <Area dataKey="value" stroke={color} fill={color} fillOpacity={0.2} />
              {selection && <ReferenceArea x1={selection.x1} x2={selection.x2} />}
            </AreaChart>
          ) : (
            <LineChart data={chartData} {...drag.handlers}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} tick={{ fontSize: 10 }} />
              <Tooltip labelFormatter={tooltipLabelFormatter} />
              <Line type="monotone" dataKey="value" stroke={color} dot={false} />
              {selection && <ReferenceArea x1={selection.x1} x2={selection.x2} />}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
