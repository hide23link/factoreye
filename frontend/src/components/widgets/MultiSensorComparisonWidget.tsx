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

import { useSensors } from "../../hooks/queries";
import { useCursorZoom } from "../../hooks/useCursorZoom";
import { useDragSelect } from "../../hooks/useDragSelect";
import { useNow } from "../../hooks/useNow";
import { fetchSensorReadingsDownsampled } from "../../lib/api";
import { buildRows, normalizeRows, rawValueOf } from "../../lib/graph-series";
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
import {
  effectiveRange,
  graphColor,
  autoAxisRange,
  bandEnds,
  graphAxisSides,
  graphDataOptions,
  graphSensorIds,
  graphYAxisPlan,
  graphStyle,
  thresholdOverlay,
} from "../../lib/graph-config";
import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { GRAPH_BUCKETS, formatTooltipValue, formatYTick, renderThresholdBands, renderThresholdLines } from "./graph-parts";

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
  // 直近モードでは、横軸（表示範囲）を設定の間隔（既定 30 秒）ごとに動かす
  // 描画のたびに Date.now() を読むと、取得の完了による再描画で取得のキーが毎秒変わり、毎秒取り直すため、useNow の値を使う
  const options = graphDataOptions(widget.config, sensorIds.length);
  const now = useNow(options.refreshMs);
  const bounds = resolveRange(range, now);
  const live = range.mode === "relative";
  // 指の画面では、なぞっても数字を出さず（スクロールの邪魔になる）、タップしたときだけ出す。なぞって期間を選ぶ操作もしない
  const coarse = useCoarsePointer();
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
      refetchInterval: live ? options.refreshMs : false,
      // 範囲が変わって新しい取得の間も、前のデータを表示し続ける（線が消えて描き直されるのを防ぐ）
      placeholderData: keepPreviousData,
    })),
  });

  if (sensorIds.length === 0) {
    return <p className="text-sm text-gray-400">比較対象のセンサーが設定されていません</p>;
  }

  const hours = spanHours(range, now);
  const formatTime = (ms: number) => formatChartTime(ms, hours);

  // 区間の中央の時刻ごとに、各センサーの値（平均・最大・最小）を1行にまとめる。
  // 積み上げでは欠けを埋め、0〜100% にそろえるときは、センサーごとに換算する（元の値はツールチップ用に残す）
  const inputs = sensorIds.flatMap((sensorId, i) => {
    const data = results[i]?.data;
    return data ? [{ sensorId, bucketSeconds: data.bucketSeconds, buckets: data.buckets }] : [];
  });
  const rawRows = buildRows(inputs, options.aggregation, { fillGaps: options.stack !== "none" });
  const chartData = options.axisMode === "normalized" ? normalizeRows(rawRows, sensorIds) : rawRows;
  // しきい値の線は、センサーが1つのときだけ重ねる（複数だと、どのセンサーの線か分からなくなるため）
  const onlySensor = sensorIds.length === 1 ? sensors?.find((s) => s.id === sensorIds[0]) : undefined;
  const style = graphStyle(widget.config);
  const overlay = thresholdOverlay(widget.config, onlySensor);
  const { lines, bands } = overlay;
  const percentStack = options.stack === "percent";
  // しきい値の帯を塗る範囲の端（帯を出すのはセンサー1つのときだけ）
  const ends = bandEnds(
    widget.config,
    chartData.flatMap((row) => (typeof row[sensorIds[0]] === "number" ? [row[sensorIds[0]]] : [])),
    overlay.axisValues,
  );
  // 単位が2種類以上なら、縦軸を左右の2つにする（実際の値のときだけ。積み上げ・0〜100% は1つの軸）
  const axis = graphAxisSides(widget.config, sensorIds, (id) => sensors?.find((s) => s.id === id)?.unit);
  const dualAxis = axis.dual && options.axisMode === "shared" && options.stack === "none";
  // 左の軸の範囲は、左に描くセンサーの値から決める（右の軸のセンサーは、右の軸の自動に任せる）
  const leftValues = chartData.flatMap((row) =>
    sensorIds.flatMap((id) => (axis.sides[id] !== "right" || !dualAxis) && typeof row[id] === "number" ? [row[id] as number] : []),
  );
  const axisPlan = graphYAxisPlan(widget.config, options, overlay.axisValues, leftValues);
  // 右の軸も、値に余白をとる（幅の狭い値が、軸の端に貼りついて消えたように見えないように）
  const rightRange = dualAxis
    ? autoAxisRange(
        chartData.flatMap((row) =>
          sensorIds.flatMap((id) => (axis.sides[id] === "right" && typeof row[id] === "number" ? [row[id] as number] : [])),
        ),
      )
    : undefined;
  const formatYAxis = {
    values: formatYTick,
    percent: (v: number) => `${Math.round(v)}%`,
    percentStack: (v: number) => `${Math.round(v * 100)}%`,
  }[axisPlan.scale];
  // ツールチップの値は、有効数字 4 桁＋センサーの単位。0〜100% にそろえたときは、グラフの値が換算後なので、元の値を出す
  const tooltipValueFormatter = (value: unknown, _name: unknown, item: { dataKey?: unknown; payload?: unknown }) => {
    const unit = sensors?.find((s) => s.id === item.dataKey)?.unit;
    return formatTooltipValue(rawValueOf(item) ?? value, unit);
  };
  // 積み上げるときは、すべての面・棒を同じ積み上げグループに入れる
  const stackId = options.stack === "none" ? undefined : "stack";

  const graphType = widget.config.graphType ?? "line";

  // 3種類のグラフで共通の部品（軸・目盛り・凡例・ドラッグ選択・しきい値の線）
  const parts = [
    style.showGrid ? <CartesianGrid key="grid" strokeDasharray="3 3" /> : null,
    <XAxis
      key="x"
      dataKey="time"
      type="number"
      domain={[bounds.from, bounds.to]}
      tickFormatter={formatTime}
      tick={{ fontSize: 10 }}
    />,
    ...(dualAxis
      ? [
          <YAxis
            key="y-left"
            yAxisId="left"
            orientation="left"
            domain={axisPlan.domain}
            width={52}
            tick={{ fontSize: 10 }}
            tickFormatter={formatYTick}
            label={axis.leftUnit ? { value: axis.leftUnit, position: "top", fontSize: 10 } : undefined}
          />,
          <YAxis
            key="y-right"
            yAxisId="right"
            orientation="right"
            domain={[widget.config.yAxisRightMin ?? rightRange?.low ?? "auto", widget.config.yAxisRightMax ?? rightRange?.high ?? "auto"]}
            width={52}
            tick={{ fontSize: 10 }}
            tickFormatter={formatYTick}
            label={axis.rightUnit ? { value: axis.rightUnit, position: "top", fontSize: 10 } : undefined}
          />,
        ]
      : [
          <YAxis
            key="y"
            domain={axisPlan.domain}
            width={44}
            tick={{ fontSize: 10 }}
            tickFormatter={formatYAxis}
            label={
              options.axisMode === "shared" && options.stack === "none" && axis.leftUnit
                ? { value: axis.leftUnit, position: "top", fontSize: 10 }
                : undefined
            }
          />,
        ]),
    style.showTooltip ? (
      <Tooltip
        key="tip"
        trigger={coarse ? "click" : "hover"}
        labelFormatter={(label: ReactNode) => formatTime(Number(label))}
        formatter={tooltipValueFormatter}
      />
    ) : null,
    style.legendPosition === "off" ? null : (
      <Legend
        key="legend"
        wrapperStyle={{ fontSize: 10 }}
        layout={style.legendPosition === "right" ? "vertical" : "horizontal"}
        verticalAlign={style.legendPosition === "right" ? "middle" : "bottom"}
        align={style.legendPosition === "right" ? "right" : "center"}
      />
    ),
    ...renderThresholdBands(bands, ends),
    ...renderThresholdLines(lines),
    drag.selection ? <ReferenceArea key="sel" x1={drag.selection.x1} x2={drag.selection.x2} /> : null,
  ];
  // 凡例に出す名前: 利用者が付けた名前（空欄なら、センサーの名前）
  const nameOf = (sensorId: string) =>
    widget.config.seriesNames?.[sensorId]?.trim() || sensors?.find((s) => s.id === sensorId)?.name || sensorId;
  // 各センサーの区間は時刻が揃わないことが多いため（= 行のほとんどは自分の値が無い）、
  // 線は connectNulls で自分の点だけを繋ぐ。5 秒ごとの更新で描き直されて見えないよう、アニメーションは止める
  const series = sensorIds.map((sensorId, i) => {
    const color = graphColor(widget, i);
    // 二軸のときは、センサーごとに載せる軸を指定する（指定しないと、どの軸にも載らない）
    const yAxisId = dualAxis ? axis.sides[sensorId] : undefined;
    if (graphType === "bar") {
      return (
        <Bar
          key={sensorId}
          yAxisId={yAxisId}
          dataKey={sensorId}
          name={nameOf(sensorId)}
          fill={color}
          stackId={stackId}
          isAnimationActive={false}
        />
      );
    }
    if (graphType === "area") {
      return (
        <Area
          key={sensorId}
          yAxisId={yAxisId}
          dataKey={sensorId}
          name={nameOf(sensorId)}
          stroke={color}
          type={style.curveType}
          strokeWidth={style.lineWidth}
          dot={style.showPoints}
          fill={color}
          stackId={stackId}
          fillOpacity={style.fillOpacity}
          isAnimationActive={false}
          connectNulls
        />
      );
    }
    return (
      <Line
        key={sensorId}
        yAxisId={yAxisId}
        type={style.curveType}
        dataKey={sensorId}
        name={nameOf(sensorId)}
        stroke={color}
        strokeWidth={style.lineWidth}
        dot={style.showPoints}
        isAnimationActive={false}
        connectNulls
      />
    );
  });

  return (
    <div className="flex h-full flex-col">
      {/* 1 つのセンサーのときだけ、センサーの名前を見出しに出す（複数のときは見出しを出さない） */}
      {sensorIds.length === 1 && <p className="mb-1 text-sm font-medium text-gray-700">{nameOf(sensorIds[0])}</p>}
      <div ref={chartRef} className="min-h-0 flex-1 select-none" style={{ touchAction: "pan-y" }}>
        <ResponsiveContainer width="100%" height="100%">
          {graphType === "bar" ? (
            <BarChart data={chartData} stackOffset={percentStack ? "expand" : "none"} {...(coarse ? {} : drag.handlers)}>
              {parts}
              {series}
            </BarChart>
          ) : graphType === "area" ? (
            <AreaChart data={chartData} stackOffset={percentStack ? "expand" : "none"} {...(coarse ? {} : drag.handlers)}>
              {parts}
              {series}
            </AreaChart>
          ) : (
            <LineChart data={chartData} {...(coarse ? {} : drag.handlers)}>
              {parts}
              {series}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
