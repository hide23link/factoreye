/**
 * 1センサーの測定値を、折れ線・棒・面グラフで表示するウィジェット。
 *
 * 表示する時間範囲は、ダッシュボードで 1 つだけ持つ（useTimeRangeStore）。
 * 範囲が長くても重くならないよう、生データではなく間引いたデータ（区間ごとの平均）を描く。
 * グラフ上でドラッグすると、その期間に拡大する。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "SensorGraph" のときに出す。
 * リンクの画面（GraphLinkView）も、同じ線・色・縦軸で描くために使う。
 * 【引数（props）】widget = このウィジェット（センサーの ID や設定を持つ）。WidgetCard が渡す。
 * linkView = リンクの画面のときだけ、GraphLinkView が渡す（範囲・今か・タップした時刻。graph-parts の LinkGraphView）。
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
import {
  GRAPH_BUCKETS,
  formatTooltipValue,
  formatYTick,
  renderCursorLine,
  renderThresholdBands,
  renderThresholdLines,
  type LinkGraphView,
} from "./graph-parts";
import { MultiSensorComparisonWidget } from "./MultiSensorComparisonWidget";

export { GRAPH_BUCKETS };

/**
 * センサーのグラフ。設定（色・グラフの種類・Y 軸の範囲）は widget.config に入っている。
 * センサーが2つ以上のときは、複数の線を重ねる描画（MultiSensorComparisonWidget）に任せる。
 * hooks を条件で呼び分けないよう、1つのセンサー用の本体は別の関数にしている。
 */
export function SensorGraphWidget({ widget, linkView }: { widget: Widget; linkView?: LinkGraphView }) {
  return graphSensorIds(widget).length > 1 ? (
    <MultiSensorComparisonWidget widget={widget} linkView={linkView} />
  ) : (
    <SingleSensorGraph widget={widget} linkView={linkView} />
  );
}

function SingleSensorGraph({ widget, linkView }: { widget: Widget; linkView?: LinkGraphView }) {
  const { data: sensors } = useSensors();
  const dashboardRange = useTimeRangeStore((s) => s.range);
  const setRange = useTimeRangeStore((s) => s.setRange);
  // ウィジェット固有の期間があればそれを使う（固有の期間のときは、ドラッグでの拡大はしない）
  const range = effectiveRange(widget, dashboardRange);
  // リンクの画面では、期間の操作はリンクの画面が受ける（ダッシュボードの期間を変えない）
  const hasOwnRange = range !== dashboardRange || linkView !== undefined;
  // 直近モードでは、横軸（表示範囲）を時間経過で動かす。動かすのは 設定の間隔（既定 30 秒）ごと
  // 描画のたびに Date.now() を読むと、取得の完了による再描画で秒が変わるたびに取得のキーが変わり、
  // 取得 → 再描画 → 新しいキー → 取得、の連鎖で毎秒取り直すため、現在時刻は useNow の値を使う
  const options = graphDataOptions(widget.config, 1);
  const now = useNow(options.refreshMs);
  const bounds = linkView?.bounds ?? resolveRange(range, now);
  // リンクの画面では、取得の範囲は表示の範囲と別に決まる（指を動かす間は取り直さない）
  const fetchBounds = linkView?.fetchBounds ?? bounds;
  const { data, isError, refetch } = useDownsampledReadings(
    widget.sensorId,
    fetchBounds,
    GRAPH_BUCKETS,
    linkView ? linkView.live : range.mode === "relative",
    options.refreshMs,
  );
  // 指の画面では、なぞっても数字を出さず（スクロールの邪魔になる）、タップしたときだけ出す。なぞって期間を選ぶ操作もしない
  const coarse = useCoarsePointer();
  const drag = useDragSelect((from, to) => {
    const next = absoluteRange(from, to);
    if (next && !hasOwnRange) setRange(next);
  });
  // リンクの画面は、指の操作を自分で受ける（ドラッグ選択・吹き出しを付けない）
  const pointerHandlers = coarse || linkView ? {} : drag.handlers;
  // Ctrl（⌘）＋ホイールで、カーソルの時刻を中心に拡大・縮小する
  const chartRef = useCursorZoom(drag.hoverTime, (anchor, factor) => {
    if (!hasOwnRange) setRange(zoomAround(range, anchor, factor, now, maxRangeForBuild()));
  });
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-500">センサーが設定されていません</p>;
  }
  if (!data && isError) {
    return <ErrorNotice message="グラフのデータを取得できませんでした。" onRetry={() => void refetch()} />;
  }
  // 最初の 1 回だけ「読み込み中」を出す（以後は前のデータを残して、取り直す）
  if (!data) {
    return <p className="text-sm text-gray-500">読み込み中...</p>;
  }

  const hours = linkView ? (bounds.to - bounds.from) / 3_600_000 : spanHours(range, now);
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
  const yDomain = graphYDomain(
    widget.config,
    overlay.axisValues,
    chartData.flatMap((point) => (typeof point.value === "number" ? [point.value] : [])),
  );
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
    // リンクの画面では、取得の範囲が表示の範囲より広いことがある。はみ出す線は枠で切る（軸を広げない）
    allowDataOverflow: linkView !== undefined,
    tickFormatter: formatTime,
    tick: { fontSize: 10 },
  };
  const tooltipLabelFormatter = (label: ReactNode) => formatTime(Number(label));
  // ツールチップは「センサー名: 値 単位」（既定の「value: 83.60231701333902」だと、何の値か分からず、桁も多すぎる）
  const seriesName = sensor?.name ?? "値";
  const tooltipValueFormatter = (value: unknown) => formatTooltipValue(value, sensor?.unit);
  const selection = drag.selection;
  const showTooltip = style.showTooltip && !linkView;

  return (
    <div className="flex h-full flex-col">
      {/* リンクの画面は、上にグラフの名前と今の値を出すので、見出しを出さない */}
      {!linkView && (
        <p className="mb-1 text-sm font-medium text-gray-700">
          {sensor?.name ?? "センサー"}
          {sensor ? ` (${sensor.unit})` : ""}
        </p>
      )}
      <div ref={chartRef} className="min-h-0 flex-1 select-none" style={{ touchAction: linkView ? "none" : "pan-y" }}>
        <ResponsiveContainer width="100%" height="100%">
          {graphType === "bar" ? (
            <BarChart data={chartData} {...pointerHandlers}>
              {style.showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} />
              {showTooltip && <Tooltip trigger={coarse ? "click" : "hover"} labelFormatter={tooltipLabelFormatter} formatter={tooltipValueFormatter} />}
              <Bar dataKey="value" name={seriesName} fill={color} isAnimationActive={false} />
              {renderThresholdBands(bands, ends)}
              {renderThresholdLines(lines)}
              {selection && <ReferenceArea x1={selection.x1} x2={selection.x2} />}
              {renderCursorLine(linkView?.cursorTime ?? null)}
            </BarChart>
          ) : graphType === "area" ? (
            <AreaChart data={chartData} {...pointerHandlers}>
              {style.showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} />
              {showTooltip && <Tooltip trigger={coarse ? "click" : "hover"} labelFormatter={tooltipLabelFormatter} formatter={tooltipValueFormatter} />}
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
              {renderCursorLine(linkView?.cursorTime ?? null)}
            </AreaChart>
          ) : (
            <LineChart data={chartData} {...pointerHandlers}>
              {style.showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} />
              {showTooltip && <Tooltip trigger={coarse ? "click" : "hover"} labelFormatter={tooltipLabelFormatter} formatter={tooltipValueFormatter} />}
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
              {renderCursorLine(linkView?.cursorTime ?? null)}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
