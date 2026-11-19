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

import { useDownsampledReadings, useLatestReadings, useSensors } from "../../hooks/queries";
import { useCursorZoom } from "../../hooks/useCursorZoom";
import { useDragSelect } from "../../hooks/useDragSelect";
import { useNow } from "../../hooks/useNow";
import { bucketValue, summarizeBuckets } from "../../lib/graph-series";
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
import { compareAvailability, compareName, compareOffsetMs, describeDiff, shiftRange, type CompareMode } from "../../lib/compare-range";
import { bandAt, computeBands, describeBand } from "../../lib/threshold-bands";
import { gapThreshold, trendLimits, type TrendPoint } from "../../lib/trend-stack";
import { useGraphViewStore } from "../../store/useGraphViewStore";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import type { Widget } from "../../types";
import { ErrorNotice } from "../ErrorNotice";
import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import {
  GRAPH_BUCKETS,
  formatTooltipValue,
  formatYTick,
  renderAlarmBands,
  renderCursorLine,
  renderThresholdBands,
  renderThresholdLines,
  type LinkGraphView,
} from "./graph-parts";
import { useGraphValueMeasure } from "../../hooks/useGraphValueMeasure";
import { withSharedCursor } from "../../lib/shared-cursor";
import { CursorResetButton, SharedCursorOverlay } from "./SharedCursor";
import { GraphValueProbe, GraphValues, type GraphValueItem } from "./GraphValues";
import { GraphViewControls } from "./GraphViewControls";
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
  // 右の「今の値」に使う、全センサーの最新の測定値（1 回の取得で、ほかのウィジェットと共有）
  const { data: latest } = useLatestReadings();
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
  // リンクの画面は、指の操作を自分で受ける（ドラッグ選択・吹き出しを付けない）。
  // それ以外は、動かした位置を、全グラフ共有のカーソルの時刻にする（指ならタップ・ドラッグも。1 区間に丸めて、描画 1 回にまとめる）
  const pointerHandlers = withSharedCursor(!linkView, (bounds.to - bounds.from) / GRAPH_BUCKETS, coarse || linkView ? {} : drag.handlers, widget.id);
  // Ctrl（⌘）＋ホイールで、カーソルの時刻を中心に拡大・縮小する
  const chartRef = useCursorZoom(drag.hoverTime, (anchor, factor) => {
    if (!hasOwnRange) setRange(zoomAround(range, anchor, factor, now, maxRangeForBuild()));
  });
  const sensor = sensors?.find((s) => s.id === widget.sensorId);
  // 右の今の値の札を置く高さ（グラフの中で測る）
  const [valueMeasure, setValueMeasure] = useGraphValueMeasure();
  // 警報の帯を出すか（この端末の設定。見出しで切り替える）
  const showBands = useGraphViewStore((s) => s.showBands);
  // 昨日・先週の重ね。リンクの画面・棒グラフ・保持期間の外になる範囲では出さない
  const selectedCompare = useGraphViewStore((s) => s.compare);
  const isBar = widget.config.graphType === "bar";
  const compareMode: CompareMode =
    linkView || isBar || !compareAvailability(selectedCompare, bounds.from, now, maxRangeForBuild()).ok ? "none" : selectedCompare;
  // 比較の線のデータ。同じ間引き API を、範囲をずらして取る（取れなくても、今の線には影響しない）
  const compareBounds = shiftRange(fetchBounds, compareMode);
  const { data: compareData } = useDownsampledReadings(
    compareMode === "none" ? null : widget.sensorId,
    compareBounds,
    GRAPH_BUCKETS,
    range.mode === "relative",
    options.refreshMs,
  );

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

  // 比較の線の点（今の時刻の位置へ進める）。今の点と時刻が同じなら、同じ行にまとめる（ツールチップが 1 回で両方を出せるように）
  const compareOffset = compareOffsetMs(compareMode);
  const comparePoints =
    compareMode !== "none" && compareData
      ? compareData.buckets.map((b) => ({ time: new Date(b.start).getTime() + compareOffset + halfBucketMs, value: bucketValue(b, options.aggregation) }))
      : [];
  const mergedByTime = new Map<number, { time: number; value?: number; compare?: number }>(chartData.map((point) => [point.time, { ...point }]));
  for (const point of comparePoints) mergedByTime.set(point.time, { ...(mergedByTime.get(point.time) ?? { time: point.time }), compare: point.value });
  const plotData: Array<{ time: number; value?: number; compare?: number }> = compareMode === "none" ? chartData : [...mergedByTime.values()].sort((a, b) => a.time - b.time);
  const compareLabel = compareName(compareMode);
  const compareLine =
    compareMode === "none" ? null : (
      <Line
        key="compare"
        type="linear"
        dataKey="compare"
        name={compareLabel}
        stroke="var(--fe-mut)"
        strokeWidth={1.4}
        strokeDasharray="4 3"
        dot={false}
        connectNulls
        isAnimationActive={false}
      />
    );

  const color = graphColor(widget, 0);
  // 縦軸の上に出す単位（単位が無いセンサーは出さない）
  const yAxisLabel = sensor?.unit ? { value: sensor.unit, position: "top" as const, fontSize: 10 } : undefined;
  // 単位の文字が上端で切れないよう、単位を出すときは上に余白をとる
  const chartMargin = yAxisLabel ? { top: 18, right: 5, left: 0, bottom: 5 } : undefined;
  // 今の値の札。高さは最新の測定値、まだ無ければグラフの最後の点
  const latestValue = latest?.readings.find((reading) => reading.sensorId === widget.sensorId)?.value;
  const lastPlotted = [...chartData].reverse().find((point) => typeof point.value === "number")?.value;
  const valueItems: GraphValueItem[] = [
    {
      name: sensor?.name ?? "値",
      color,
      unit: sensor?.unit ?? "",
      value: latestValue,
      position: latestValue ?? lastPlotted ?? undefined,
      stats: summarizeBuckets(data.buckets),
    },
  ];
  const valueProbe = linkView ? null : <GraphValueProbe items={valueItems} onMeasure={setValueMeasure} />;
  const graphType = widget.config.graphType ?? "line";
  const style = graphStyle(widget.config);
  const overlay = thresholdOverlay(widget.config, sensor);
  const { lines, bands } = overlay;
  // 警報の帯。しきい値の線・色の帯の設定（thresholdMode）とは別。線の点と同じ値で判定する（しきい値が未設定なら帯なし）
  const linePoints: TrendPoint[] = chartData.flatMap((point) => (typeof point.value === "number" ? [{ time: point.time, value: point.value }] : []));
  const alarmBands =
    showBands && sensor
      ? computeBands(linePoints, trendLimits(sensor), gapThreshold(linePoints, data.bucketSeconds * 1000))
      : [];
  const alarmBandElements = renderAlarmBands(alarmBands, bounds.from, bounds.to);
  const yDomain = graphYDomain(
    widget.config,
    overlay.axisValues,
    // 縦軸の範囲は、今日と比較の両方が入るようにそろえる
    [...chartData, ...comparePoints].flatMap((point) => (typeof point.value === "number" ? [point.value] : [])),
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
  // カーソルが警報の帯の中にあれば、時刻の後ろに「警報 11:42〜12:58 最高 89.2」を添える
  const tooltipLabelFormatter = (label: ReactNode) => {
    const band = bandAt(alarmBands, Number(label), halfBucketMs);
    if (!band) return formatTime(Number(label));
    return `${formatTime(Number(label))}\u3000${describeBand(band, formatTime, (value) => formatTooltipValue(value, sensor?.unit))}`;
  };
  // ツールチップは「センサー名: 値 単位」（既定の「value: 83.60231701333902」だと、何の値か分からず、桁も多すぎる）
  const seriesName = sensor?.name ?? "値";
  // 比較の線は「昨日: 62.4 ℃（差 +4.1）」。差は 今の値 − 比較の値
  const tooltipValueFormatter = (value: unknown, name?: unknown, _item?: unknown, _index?: number, payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown }>) => {
    const text = formatTooltipValue(value, sensor?.unit);
    const today = payload?.find((entry) => entry.dataKey === "value")?.value;
    if (name !== compareLabel || compareMode === "none" || typeof value !== "number" || typeof today !== "number") return text;
    return `${text}${describeDiff(value, today, (v) => formatTooltipValue(v, undefined))}`;
  };
  const selection = drag.selection;
  const showTooltip = style.showTooltip && !linkView;

  return (
    <div className="relative flex h-full flex-col">
      {!linkView && <CursorResetButton widgetId={widget.id} />}
      {/* リンクの画面は、上にグラフの名前と今の値を出すので、見出しを出さない */}
      {!linkView && (
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm font-medium text-gray-700">
            {sensor?.name ?? "センサー"}
            {sensor ? ` (${sensor.unit})` : ""}
          </p>
          <GraphViewControls rangeFrom={bounds.from} nowMs={now} compareDisabledReason={isBar ? "棒グラフでは、昨日・先週を重ねられません" : undefined} />
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-1.5">
      <div ref={chartRef} className="min-h-0 min-w-0 flex-1 select-none" style={{ touchAction: linkView ? "none" : "pan-y" }}>
        <ResponsiveContainer width="100%" height="100%">
          {graphType === "bar" ? (
            <BarChart data={chartData} margin={chartMargin} {...pointerHandlers}>
              {style.showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} label={yAxisLabel} />
              {alarmBandElements}
              {showTooltip && <Tooltip trigger={coarse ? "click" : "hover"} labelFormatter={tooltipLabelFormatter} formatter={tooltipValueFormatter} />}
              <Bar dataKey="value" name={seriesName} fill={color} isAnimationActive={false} />
              {renderThresholdBands(bands, ends)}
              {renderThresholdLines(lines)}
              {selection && <ReferenceArea x1={selection.x1} x2={selection.x2} />}
              {linkView ? renderCursorLine(linkView.cursorTime ?? null) : <SharedCursorOverlay from={bounds.from} to={bounds.to} />}
              {valueProbe}
            </BarChart>
          ) : graphType === "area" ? (
            <AreaChart data={plotData} margin={chartMargin} {...pointerHandlers}>
              {style.showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} label={yAxisLabel} />
              {alarmBandElements}
              {showTooltip && <Tooltip trigger={coarse ? "click" : "hover"} labelFormatter={tooltipLabelFormatter} formatter={tooltipValueFormatter} />}
              {compareLine}
              <Area
                connectNulls={compareMode !== "none"}
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
              {linkView ? renderCursorLine(linkView.cursorTime ?? null) : <SharedCursorOverlay from={bounds.from} to={bounds.to} />}
              {valueProbe}
            </AreaChart>
          ) : (
            <LineChart data={plotData} margin={chartMargin} {...pointerHandlers}>
              {style.showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis {...xAxisProps} />
              <YAxis domain={yDomain} width={44} tick={{ fontSize: 10 }} tickFormatter={formatYTick} label={yAxisLabel} />
              {alarmBandElements}
              {showTooltip && <Tooltip trigger={coarse ? "click" : "hover"} labelFormatter={tooltipLabelFormatter} formatter={tooltipValueFormatter} />}
              {compareLine}
              <Line
                connectNulls={compareMode !== "none"}
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
              {linkView ? renderCursorLine(linkView.cursorTime ?? null) : <SharedCursorOverlay from={bounds.from} to={bounds.to} />}
              {valueProbe}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      {/* 右に、今の値（リンクの画面では出さない） */}
      {!linkView && (
        <GraphValues items={valueItems} decimals={widget.config.decimals} measure={valueMeasure} />
      )}
      </div>
    </div>
  );
}
