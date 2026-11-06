/**
 * 1センサーの測定値を、折れ線・棒・面グラフで表示するウィジェット。
 *
 * 表示する時間範囲は、ダッシュボードで 1 つだけ持つ（useTimeRangeStore）。
 * 範囲が長くても重くならないよう、生データではなく間引いたデータ（区間ごとの平均）を描く。
 * グラフ上でドラッグすると、その期間に拡大する。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "SensorGraph" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーの ID や設定を持つ）。WidgetCard が渡す。
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
import { bucketValue } from "../../lib/graph-series";
import { formatChartTime } from "../../lib/time";
import {
  effectiveRange,
  graphColor,
  graphSensorIds,
  bandEnds,
  graphDataOptions,
  graphStyle,
  graphYDomain,
  thresholdOverlay,
} from "../../lib/graph-config";
import {
  absoluteRange,
  maxRangeForBuild,
  resolveRange,
  spanHours,
  zoomAround,
} from "../../lib/timeRange";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import type { Widget } from "../../types";
import { ErrorNotice } from "../ErrorNotice";
import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { GRAPH_BUCKETS, formatTooltipValue, formatYTick, renderThresholdBands, renderThresholdLines } from "./graph-parts";
import { MultiSensorComparisonWidget } from "./MultiSensorComparisonWidget";

export { GRAPH_BUCKETS };

/**
 * センサーのグラフ。設定（色・グラフの種類・Y 軸の範囲）は widget.config に入っている。
 * センサーが2つ以上のときは、複数の線を重ねる描画（MultiSensorComparisonWidget）に任せる。
 * hooks を条件で呼び分けないよう、1つのセンサー用の本体は別の関数にしている。
 */
export function SensorGraphWidget({ widget }: { widget: Widget }) {
  return graphSensorIds(widget).length > 1 ? (
    <MultiSensorComparisonWidget widget={widget} />
  ) : (
    <SingleSensorGraph widget={widget} />
  );
}

function SingleSensorGraph({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const dashboardRange = useTimeRangeStore((s) => s.range);
  const setRange = useTimeRangeStore((s) => s.setRange);
  // ウィジェット固有の期間があればそれを使う（固有の期間のときは、ドラッグでの拡大はしない）
  const range = effectiveRange(widget, dashboardRange);
  const hasOwnRange = range !== dashboardRange;
  // 直近モードでは、横軸（表示範囲）を時間経過で動かす。動かすのは 設定の間隔（既定 30 秒）ごと
  // 描画のたびに Date.now() を読むと、取得の完了による再描画で秒が変わるたびに取得のキーが変わり、
  // 取得 → 再描画 → 新しいキー → 取得、の連鎖で毎秒取り直すため、現在時刻は useNow の値を使う
  const options = graphDataOptions(widget.config, 1);
  const now = useNow(options.refreshMs);
  const bounds = resolveRange(range, now);
  const { data, isError, refetch } = useDownsampledReadings(
    widget.sensorId,
    bounds,
    GRAPH_BUCKETS,
    range.mode === "relative",
    options.refreshMs,
  );
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
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-400">センサーが設定されていません</p>;
  }
  if (!data && isError) {
    return <ErrorNotice message="グラフのデータを取得できませんでした。" onRetry={() => void refetch()} />;
  }
  // 最初の 1 回だけ「読み込み中」を出す（以後は前のデータを残して、取り直す）
  if (!data) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  const hours = spanHours(range, now);
  const formatTime = (ms: number) => formatChartTime(ms, hours);

  // 区間の中央の時刻に、区間の平均を置く（区間の幅の半分ずらす）
  const halfBucketMs = (data.bucketSeconds * 1000) / 2;
  const chartData = data.buckets.map((b) => ({
    time: new Date(b.start).getTime() + halfBucketMs,
    value: bucketValue(b, options.aggregation),
  }));

  const color = graphColor(widget, 0);
  const graphType = widget.config.graphType ?? "line";
  const style = graphStyle(widget.config);
  const overlay = thresholdOverlay(widget.config, sensor);
  const { lines, bands } = overlay;
  const yDomain = graphYDomain(widget.config, overlay.axisValues);
  const ends = bandEnds(
    widget.config,
    chartData.map((point) => point.value),
    overlay.axisValues,
  );

  // 横軸の共通の設定（時刻の数値を、表示用の文字列に変換する）
  const xAxisProps = {
    dataKey: "time",
    type: "number" as const,
    domain: [bounds.from, bounds.to] as [number, number],
    tickFormatter: formatTime,
    tick: { fontSize: 10 },
  };
  const tooltipLabelFormatter = (label: ReactNode) => formatTime(Number(label));
  // ツールチップは「センサー名: 値 単位」（既定の「value: 83.60231701333902」だと、何の値か分からず、桁も多すぎる）
  const seriesName = sensor?.name ?? "値";
  const tooltipValueFormatter = (value: unknown) => formatTooltipValue(value, sensor?.unit);
  const selection = drag.selection;

  return (
    <div className="flex h-full flex-col">
      <p className="mb-1 text-sm font-medium text-gray-700">
        {sensor?.name ?? "センサー"}
        {sensor ? ` (${sensor.unit})` : ""}
      </p>
      <div ref={chartRef} className="min-h-0 flex-1 select-none" style={{ touchAction: "pan-y" }}>
        <ResponsiveContainer width="100%" height="100%">
          {graphType === "bar" ? (
            <BarChart data={chartData} {...(coarse ? {} : drag.handlers)}>
              {style.showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} />
              {style.showTooltip && <Tooltip trigger={coarse ? "click" : "hover"} labelFormatter={tooltipLabelFormatter} formatter={tooltipValueFormatter} />}
              <Bar dataKey="value" name={seriesName} fill={color} isAnimationActive={false} />
              {renderThresholdBands(bands, ends)}
              {renderThresholdLines(lines)}
              {selection && <ReferenceArea x1={selection.x1} x2={selection.x2} />}
            </BarChart>
          ) : graphType === "area" ? (
            <AreaChart data={chartData} {...(coarse ? {} : drag.handlers)}>
              {style.showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} />
              {style.showTooltip && <Tooltip trigger={coarse ? "click" : "hover"} labelFormatter={tooltipLabelFormatter} formatter={tooltipValueFormatter} />}
              <Area
                dataKey="value"
                name={seriesName}
                type={style.curveType}
                stroke={color}
                strokeWidth={style.lineWidth}
                fill={color}
                fillOpacity={style.fillOpacity}
                dot={style.showPoints}
                isAnimationActive={false}
              />
              {renderThresholdBands(bands, ends)}
              {renderThresholdLines(lines)}
              {selection && <ReferenceArea x1={selection.x1} x2={selection.x2} />}
            </AreaChart>
          ) : (
            <LineChart data={chartData} {...(coarse ? {} : drag.handlers)}>
              {style.showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} />
              {style.showTooltip && <Tooltip trigger={coarse ? "click" : "hover"} labelFormatter={tooltipLabelFormatter} formatter={tooltipValueFormatter} />}
              <Line
                type={style.curveType}
                dataKey="value"
                name={seriesName}
                stroke={color}
                strokeWidth={style.lineWidth}
                dot={style.showPoints}
                isAnimationActive={false}
              />
              {renderThresholdBands(bands, ends)}
              {renderThresholdLines(lines)}
              {selection && <ReferenceArea x1={selection.x1} x2={selection.x2} />}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
