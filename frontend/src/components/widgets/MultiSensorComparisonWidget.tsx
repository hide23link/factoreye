/**
 * 複数のセンサーの値を、1つのグラフに重ねて比較するウィジェット。
 *
 * 表示する時間範囲は、ダッシュボードで 1 つだけ持つ（useTimeRangeStore）。
 * センサーごとに間引いたデータを取り（useQueries）、区間の開始時刻をそろえて1本の表にしてから描く。
 * 同じ範囲・同じ区間数で取るので、時間軸はすべてのセンサーで一致する。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "MultiSensorComparison" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーの ID や設定を持つ）。WidgetCard が渡す。
 */
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
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

import { LIVE_CHART_INTERVAL_MS, useSensors } from "../../hooks/queries";
import { useCursorZoom } from "../../hooks/useCursorZoom";
import { useDragSelect } from "../../hooks/useDragSelect";
import { useNow } from "../../hooks/useNow";
import { fetchSensorReadingsDownsampled } from "../../lib/api";
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
import { effectiveRange, graphColor, graphSensorIds, graphYDomain, thresholdLines } from "../../lib/graph-config";
import { GRAPH_BUCKETS, formatYTick, renderThresholdLines } from "./graph-parts";

/**
 * 複数センサーの比較グラフ。比較するセンサーは graphSensorIds（config.sensorIds）で決まる。
 * センサーグラフ（SensorGraph）でセンサーを2つ以上にしたときも、これで描く。
 * 線・面・棒の種類と、線の色（config.colors）、ウィジェット固有の期間も反映する。
 */
export function MultiSensorComparisonWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const sensorIds = graphSensorIds(widget);
  const dashboardRange = useTimeRangeStore((s) => s.range);
  // ウィジェット固有の期間があればそれを使う（固有の期間のときは、ドラッグでの拡大はしない）
  const range = effectiveRange(widget, dashboardRange);
  const hasOwnRange = range !== dashboardRange;
  const setRange = useTimeRangeStore((s) => s.setRange);
  // 直近モードでは、横軸（表示範囲）を 30 秒ごと（LIVE_CHART_INTERVAL_MS）に動かす
  // 描画のたびに Date.now() を読むと、取得の完了による再描画で取得のキーが毎秒変わり、毎秒取り直すため、useNow の値を使う
  const now = useNow(LIVE_CHART_INTERVAL_MS);
  const bounds = resolveRange(range, now);
  const live = range.mode === "relative";
  const drag = useDragSelect((from, to) => {
    const next = absoluteRange(from, to);
    if (next && !hasOwnRange) setRange(next);
  });
  // Ctrl（⌘）＋ホイールで、カーソルの時刻を中心に拡大・縮小する
  const chartRef = useCursorZoom(drag.hoverTime, (anchor, factor) => {
    if (!hasOwnRange) setRange(zoomAround(range, anchor, factor, now, maxRangeForBuild()));
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
      refetchInterval: live ? LIVE_CHART_INTERVAL_MS : false,
      // 範囲が変わって新しい取得の間も、前のデータを表示し続ける（線が消えて描き直されるのを防ぐ）
      placeholderData: keepPreviousData,
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
  // しきい値の線は、センサーが1つのときだけ重ねる（複数だと、どのセンサーの線か分からなくなるため）
  const onlySensor = sensorIds.length === 1 ? sensors?.find((s) => s.id === sensorIds[0]) : undefined;
  const lines = widget.config.showThresholds && onlySensor ? thresholdLines(onlySensor) : [];
  const yDomain = graphYDomain(
    widget.config,
    lines.map((l) => l.value),
  );
  const graphType = widget.config.graphType ?? "line";

  // 3種類のグラフで共通の部品（軸・目盛り・凡例・ドラッグ選択・しきい値の線）
  const parts = [
    <CartesianGrid key="grid" strokeDasharray="3 3" />,
    <XAxis
      key="x"
      dataKey="time"
      type="number"
      domain={[bounds.from, bounds.to]}
      tickFormatter={formatTime}
      tick={{ fontSize: 10 }}
    />,
    <YAxis key="y" domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} />,
    <Tooltip key="tip" labelFormatter={(label: ReactNode) => formatTime(Number(label))} />,
    <Legend key="legend" wrapperStyle={{ fontSize: 10 }} />,
    ...renderThresholdLines(lines),
    drag.selection ? <ReferenceArea key="sel" x1={drag.selection.x1} x2={drag.selection.x2} /> : null,
  ];
  const nameOf = (sensorId: string) => sensors?.find((s) => s.id === sensorId)?.name ?? sensorId;
  // 各センサーの区間は時刻が揃わないことが多いため（= 行のほとんどは自分の値が無い）、
  // 線は connectNulls で自分の点だけを繋ぐ。5 秒ごとの更新で描き直されて見えないよう、アニメーションは止める
  const series = sensorIds.map((sensorId, i) => {
    const color = graphColor(widget, i);
    if (graphType === "bar") {
      return <Bar key={sensorId} dataKey={sensorId} name={nameOf(sensorId)} fill={color} isAnimationActive={false} />;
    }
    if (graphType === "area") {
      return (
        <Area
          key={sensorId}
          dataKey={sensorId}
          name={nameOf(sensorId)}
          stroke={color}
          fill={color}
          fillOpacity={0.2}
          isAnimationActive={false}
          connectNulls
        />
      );
    }
    return (
      <Line
        key={sensorId}
        type="monotone"
        dataKey={sensorId}
        name={nameOf(sensorId)}
        stroke={color}
        dot={false}
        isAnimationActive={false}
        connectNulls
      />
    );
  });

  return (
    <div className="flex h-full flex-col">
      <p className="mb-1 text-sm font-medium text-gray-700">
        {widget.type === "MultiSensorComparison" || sensorIds.length > 1 ? "複数センサー比較" : nameOf(sensorIds[0])}
      </p>
      <div ref={chartRef} className="min-h-0 flex-1 select-none">
        <ResponsiveContainer width="100%" height="100%">
          {graphType === "bar" ? (
            <BarChart data={chartData} {...drag.handlers}>
              {parts}
              {series}
            </BarChart>
          ) : graphType === "area" ? (
            <AreaChart data={chartData} {...drag.handlers}>
              {parts}
              {series}
            </AreaChart>
          ) : (
            <LineChart data={chartData} {...drag.handlers}>
              {parts}
              {series}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
