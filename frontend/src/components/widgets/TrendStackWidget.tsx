/**
 * 計器グラフ。1 センサーを 1 行にして、時間の軸をそろえて縦に並べる（操作室の計器のように、値をきちんと読むためのグラフ）。
 *
 * 1 行に出すもの:
 * - 左: センサー名、しきい値の範囲、表示範囲の最高（時刻）・最低（時刻）・平均
 * - 縦軸: 切りのよい目盛りの数字と横線（lib/trend-stack.ts の niceScale）
 * - 線: 区間の値（平均など）。しきい値を超えた部分は、重故障＝赤、軽故障＝橙で重ねる
 * - しきい値の線（水色の点線）と、その数値
 * - 最高・最低の点と、その値・時刻
 * - 右端: 今の値の札（縦軸の今の値の高さを指す）。受信が止まったら橙で「---」
 * 全行で同じ時刻の縦線と値が出る（カーソル）。最初は「現在位置」（表示範囲の右端）に出ていて、直近の表示では、動かすまで今に追従する。
 * グラフの上でマウスを動かす（スマホはタップ・ドラッグ）と、その位置に動き、マウスが外れてもその位置に残る。時刻は、縦線の真下（時間の軸の行）に札で出す。
 * カーソルの時刻は、同じダッシュボードのすべてのグラフ（ふつうのグラフ・複数のグラフも）と共有する（useCursorTimeStore）。
 * 見出しの「今に戻す」で、現在位置に戻す。
 * カーソルの時刻と各行の値は useTrendCursorStore に出し、同じ画面の警報の欄の下に「カーソルの時刻の値」として並ぶ。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "TrendStack" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーは config.sensorIds、先頭は sensorId にも入る）。WidgetCard が渡す。
 * 表示範囲は、ほかのグラフと同じく画面上部の時間の操作（useTimeRangeStore）に従う。
 */
import { memo, useEffect, useMemo, useRef, type PointerEvent, type ReactNode } from "react";

import { useDownsampledReadings, useLatestReadings, useSensors } from "../../hooks/queries";
import { useElementSize } from "../../hooks/useElementSize";
import { useNow } from "../../hooks/useNow";
import { effectiveRange, graphDataOptions, graphSensorIds, type Aggregation } from "../../lib/graph-config";
import { resolveRange, type ResolvedRange } from "../../lib/timeRange";
import {
  CURSOR_LABEL_HEIGHT,
  boxesOverlap,
  describeInterval,
  estimateTextWidth,
  describeSpanShort,
  formatRangeJst,
  formatTick,
  formatTickTime,
  formatTrendValue,
  gapThreshold,
  levelOf,
  linePath,
  maxTimeTicks,
  placeCursorLabel,
  placeExtremeLabels,
  placeTimeLabel,
  shownCursorTime,
  type LabelBox,
  type PlacedLabel,
  niceScale,
  overPath,
  pointNear,
  staleAfterMs,
  timeTicks,
  toPoints,
  trendLimits,
  trendStats,
  xPercent,
  yPercent,
  PLOT_BOTTOM,
  PLOT_TOP,
  type AxisScale,
  type TrendLimit,
  type TrendPoint,
} from "../../lib/trend-stack";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { requestCursorTime, useCursorTimeStore } from "../../store/useCursorTimeStore";
import { useTrendCursorStore } from "../../store/useTrendCursorStore";
import type { Reading, Sensor, Widget } from "../../types";
import { GRAPH_BUCKETS } from "./graph-parts";

// 色はすべて theme.css の意味の色（暗い・明るいで切り替わる）
const INK = "var(--fe-ink)";
const MUTED = "var(--fe-mut)";
const CYAN = "var(--fe-cy)";
const AMBER = "var(--fe-amb)";
const RED = "var(--fe-red)";

/** 行の状態ごとの色（重故障＝赤、軽故障・受信なし＝橙、正常＝今の値の色） */
function stateColor(level: "critical" | "warning" | "normal", stale: boolean): string {
  if (stale) return AMBER;
  return level === "critical" ? RED : level === "warning" ? AMBER : INK;
}

/** 計器グラフの本体。行（センサー）ごとに TrendRow を並べ、カーソルの時刻を全行で共有する */
export function TrendStackWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  // 今の値は、区間の平均ではなく本当の最新の測定値を使う（全センサー分を 1 回で取る。数値ウィジェットと同じ値・同じ色になる）
  const { data: latest } = useLatestReadings();
  const dashboardRange = useTimeRangeStore((s) => s.range);
  const range = effectiveRange(widget, dashboardRange);
  const options = graphDataOptions(widget.config, 1);
  const now = useNow(options.refreshMs);
  const resolved = resolveRange(range, now);
  // 範囲の値が同じなら、同じオブジェクトを使い続ける（行（TrendRow）が、カーソルが動くだけでは、重い計算をやり直さないように）
  const bounds = useMemo<ResolvedRange>(() => ({ from: resolved.from, to: resolved.to }), [resolved.from, resolved.to]);
  const ids = graphSensorIds(widget);
  // カーソルの時刻（ミリ秒）。全グラフで共有する。null は、利用者が動かしていない（現在位置＝表示範囲の右端に、今に追従して出す）
  const cursorTime = useCursorTimeStore((s) => s.time);
  const resetCursor = useCursorTimeStore((s) => s.reset);
  const span = bounds.to - bounds.from;
  const shownCursor = shownCursorTime(cursorTime, bounds.from, bounds.to);
  // 時間の軸の目盛りの数は、軸の幅から決める（スマホの狭い幅で、時刻の文字が重ならないように）
  const axisRef = useRef<HTMLDivElement>(null);
  const { width: axisWidth } = useElementSize(axisRef);
  const ticks = useMemo(() => timeTicks(bounds.from, bounds.to, maxTimeTicks(axisWidth)), [bounds, axisWidth]);
  // 時間の軸の行に出す、カーソルの時刻の札の位置（軸の幅が測れる前は、標準の幅 600px で決める）
  const plotWidth = axisWidth > 0 ? axisWidth : 600;
  const timeText = formatTickTime(shownCursor, span);
  const timeLabel = placeTimeLabel(
    (xPercent(shownCursor, bounds.from, bounds.to) / 100) * plotWidth,
    estimateTextWidth(timeText, 12) + 12,
    plotWidth,
  );

  // カーソルの時刻を、警報の欄の下の「カーソルの時刻の値」に渡す。この計器グラフが消えたら取り下げる
  const publishCursor = useTrendCursorStore((s) => s.setCursor);
  useEffect(() => {
    publishCursor(widget.id, shownCursor, span);
  }, [widget.id, shownCursor, span, publishCursor]);
  // この計器グラフが消えたら、この計器グラフの分だけ取り下げる（ほかの計器グラフの分は残す）
  useEffect(() => () => useTrendCursorStore.getState().clear(widget.id), [widget.id]);

  // 動かした位置を、共有のカーソルの時刻にする（グラフの 1 区間に丸め、描画 1 回にまとめる）。
  // マウスが外れても、指を離しても、カーソルはその位置に残す（勝手に今へ戻さない。戻すのは「今に戻す」）。
  // 行（TrendRow）に渡すので、範囲が変わらないかぎり同じ関数を使い続ける
  const pointer = useMemo<PlotPointerHandlers>(() => {
    const moveCursor = (event: PointerEvent<HTMLDivElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      // 幅が分からない（描く前など）ときは、時刻を決められないので何もしない
      if (box.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      requestCursorTime(bounds.from + ratio * (bounds.to - bounds.from), (bounds.to - bounds.from) / GRAPH_BUCKETS);
    };
    return { onPointerMove: moveCursor, onPointerDown: moveCursor };
  }, [bounds]);

  if (ids.length === 0) {
    return <p className="text-sm text-gray-500">センサーが設定されていません（編集で、センサーをこのウィジェットに入れてください）</p>;
  }

  return (
    <div className="trend-stack flex h-full min-h-0 flex-col text-[13px]" style={{ color: INK }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-1 pb-1 text-[11px]" style={{ borderColor: "var(--fe-line)", color: MUTED }}>
        <span className="font-bold" style={{ color: INK }}>
          推移 {describeSpanShort(span)}
        </span>
        <span className="font-num">
          {formatRangeJst(bounds.from, bounds.to)}&emsp;{describeInterval(span / GRAPH_BUCKETS)}ごと
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <i className="inline-block w-3.5 border-t border-dashed" style={{ borderColor: CYAN }} aria-hidden="true" />
          しきい値
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-0.5 w-3.5" style={{ background: RED }} aria-hidden="true" />
          超過
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-full border" style={{ borderColor: INK }} aria-hidden="true" />
          最高・最低
        </span>
        <span className="rounded-sm px-1.5 font-num font-bold" style={{ background: INK, color: "var(--fe-panel)" }} aria-live="polite">
          カーソル {formatTickTime(shownCursor, span)}
        </span>
        {/* 動かしたあとだけ出る。全グラフのカーソルを、現在位置（右端）に戻す */}
        {cursorTime !== null && (
          <button type="button" onClick={resetCursor} className="rounded border px-1.5 font-bold hover:opacity-80" style={{ borderColor: "var(--fe-line)", color: INK }}>
            今に戻す
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {ids.map((id, index) => (
          <TrendRow
            key={id}
            sensorId={id}
            sensor={sensors?.find((s) => s.id === id)}
            latest={latest?.readings.find((reading) => reading.sensorId === id)}
            bounds={bounds}
            live={range.mode === "relative"}
            refreshMs={options.refreshMs}
            aggregation={options.aggregation}
            decimals={widget.config.decimals}
            cursor={shownCursor}
            widgetId={widget.id}
            order={index}
            ticks={ticks}
            pointer={pointer}
          />
        ))}
      </div>
      <div className="trend-row border-t" style={{ borderColor: "var(--fe-line)" }} aria-hidden="true">
        <span className="trend-side" />
        <span />
        <div ref={axisRef} className="relative h-5 font-num text-[11px]" style={{ color: MUTED }}>
          {ticks.map((time) => {
            // 時刻の札と重なる目盛りの文字は薄くする（札を優先）
            const tickText = formatTickTime(time, span);
            const tickWidth = estimateTextWidth(tickText, 11);
            const tickLeft = (xPercent(time, bounds.from, bounds.to) / 100) * plotWidth - tickWidth / 2;
            const covered = boxesOverlap({ left: tickLeft, top: 0, width: tickWidth, height: 14 }, timeLabel);
            return (
              <span
                key={time}
                className="absolute top-0.5 -translate-x-1/2 whitespace-nowrap"
                style={{ left: `${xPercent(time, bounds.from, bounds.to)}%`, opacity: covered ? 0.2 : 1 }}
              >
                {tickText}
              </span>
            );
          })}
          {/* カーソルの時刻の札。縦線の真下（時間の軸の行）に出す。左端・右端では内側に寄せる */}
          <span
            data-testid="cursor-time-label"
            className="absolute z-10 whitespace-nowrap rounded-sm px-1.5 font-num text-xs font-bold leading-4"
            style={{ left: timeLabel.left, top: 0, background: INK, color: "var(--fe-panel)" }}
          >
            {timeText}
          </span>
        </div>
        <span className="pr-2 pt-0.5 text-right text-[11px]" style={{ color: MUTED }}>
          今
        </span>
      </div>
    </div>
  );
}

/** グラフの上の操作（マウスを動かす・指で触れる）で、カーソルの時刻を更新する */
interface PlotPointerHandlers {
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}

interface RowProps {
  sensorId: string;
  sensor: Sensor | undefined;
  // このセンサーの最新の測定値（GET /api/sensors/latest）。取れないときは、最後の区間の値を使う
  latest: Reading | undefined;
  bounds: ResolvedRange;
  live: boolean;
  refreshMs: number;
  aggregation: Aggregation;
  decimals: number | undefined;
  /** カーソルの時刻（ミリ秒） */
  cursor: number;
  /** この行がある計器グラフ（ウィジェット）の ID（カーソルの値の置き場のキー） */
  widgetId: string;
  /** 計器グラフの中の行の順（カーソルの時刻の値の並び順に使う） */
  order: number;
  ticks: number[];
  pointer: PlotPointerHandlers;
}

/**
 * 1 センサー分の行。データの取得（間引き）は行ごとに行う。
 * 重い計算（点・最高最低・目盛り・線の形）は、データや範囲が変わったときだけやり直す（buildRowModel を useMemo で）。
 * 線・目盛り・しきい値の絵は PlotStatic に分け、カーソルが動くだけでは描き直さない。
 * React.memo で、親の描き直しのうち、この行に関係する値（props）が変わらないものでは、行ごと飛ばす。
 */
const TrendRow = memo(function TrendRow({ sensorId, sensor, latest, bounds, live, refreshMs, aggregation, decimals, cursor, widgetId, order, ticks, pointer }: RowProps) {
  const { data, isError, refetch } = useDownsampledReadings(sensorId, bounds, GRAPH_BUCKETS, live, refreshMs);
  // 行の高さに合わせて目盛りの数を決める（1 目盛りに 22px 以上。スマホの低い行で数字が重ならないように）
  const rowRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(rowRef);
  const maxIntervals = height > 0 ? Math.min(7, Math.max(2, Math.floor(height / 22))) : 7;
  const name = sensor?.name ?? "センサー";
  const unit = sensor?.unit ?? "";
  const model = useMemo(
    () => (data ? buildRowModel({ data, aggregation, sensor, latest, bounds, live, maxIntervals, decimals, unit }) : null),
    [data, aggregation, sensor, latest, bounds, live, maxIntervals, decimals, unit],
  );

  if (!data || !model) {
    return (
      <div ref={rowRef} className="trend-cell flex min-h-[88px] flex-1 flex-col border-b" style={{ borderColor: "var(--fe-line)" }}>
        <div className="trend-row min-h-0 flex-1">
          <RowSide name={name} sub={isError ? "データを取得できませんでした" : "読み込み中..."} subColor={isError ? AMBER : MUTED} />
          <span />
          <div className="flex items-center px-2 text-xs" style={{ color: MUTED }}>
            {isError ? (
              <button type="button" className="underline" onClick={() => void refetch()}>
                もう一度読み込む
              </button>
            ) : (
              "読み込み中..."
            )}
          </div>
          <span />
        </div>
      </div>
    );
  }

  const { points, stats, limits, scale, now, stale, level, gapMs, color, format, sub, lineD, warningD, criticalD } = model;
  const span = bounds.to - bounds.from;

  const cursorPoint = pointNear(points, cursor, gapMs / 2);
  const cursorText = cursorPoint ? format(cursorPoint.value) : "---";
  const rowBackground = !stale && level === "critical" ? "var(--fe-red-row)" : undefined;
  const nameColor = stale || level !== "normal" ? color : INK;

  return (
    <div ref={rowRef} className="trend-cell flex min-h-[88px] flex-1 flex-col border-b" style={{ borderColor: "var(--fe-line)", background: rowBackground }}>
      <CursorValuePublisher widgetId={widgetId} id={sensorId} order={order} name={name} unit={unit} value={cursorText} color={nameColor} />
      {/* 狭い枠（スマホ）では、左の欄が無いので、行の上に名前・範囲・最高・最低を 1 行で出す（グラフの文字と重ならないように） */}
      <div className="trend-headline items-baseline gap-2 px-1.5 pt-1 text-[11px]">
        <span className="min-w-0 truncate font-bold" style={{ color: nameColor }} title={name}>
          {name}
        </span>
        <span className="min-w-0 truncate font-num" style={{ color: stale ? AMBER : MUTED }}>
          {sub}
        </span>
        {stats && (
          <span className="ml-auto shrink-0 font-num" style={{ color: MUTED }}>
            最高 <b style={{ color: INK }}>{format(stats.max.value)}</b>&emsp;最低 <b style={{ color: INK }}>{format(stats.min.value)}</b>
          </span>
        )}
      </div>
      <div className="trend-row min-h-0 flex-1">
        <RowSide name={name} nameColor={stale || level !== "normal" ? color : INK} sub={sub} subColor={stale ? AMBER : MUTED}>
          {stats && (
            <dl className="mt-1 grid grid-cols-[2.2em_auto_1fr] items-baseline gap-x-1.5 font-num text-[11px]">
              <dt style={{ color: MUTED }}>最高</dt>
              <dd className="text-right font-bold">{format(stats.max.value)}</dd>
              <dd style={{ color: MUTED }}>{formatTickTime(stats.max.time, span)}</dd>
              <dt style={{ color: MUTED }}>最低</dt>
              <dd className="text-right font-bold">{format(stats.min.value)}</dd>
              <dd style={{ color: MUTED }}>{formatTickTime(stats.min.time, span)}</dd>
              <dt style={{ color: MUTED }}>平均</dt>
              <dd className="text-right font-bold">{format(stats.average)}</dd>
              <dd style={{ color: MUTED }}>{unit}</dd>
            </dl>
          )}
        </RowSide>
        <YAxis scale={scale} unit={unit} />
        <PlotBox pointer={pointer}>
          {(plot) => {
            // 札の位置（px）。カーソルの札を先に決め、最高・最低の札はそれと重ならないよう置く
            const cursorText = cursorPoint ? `${format(cursorPoint.value)} ${unit}` : "データなし";
            const cursorX = (xPercent(cursor, bounds.from, bounds.to) / 100) * plot.width;
            const cursorY = cursorPoint ? (yPercent(cursorPoint.value, scale) / 100) * plot.height : plot.height / 2;
            const cursorBox = placeCursorLabel(
              { x: cursorX, y: cursorY },
              { width: estimateTextWidth(cursorText, 12) + 12, height: CURSOR_LABEL_HEIGHT },
              plot,
            );
            const maxText = stats ? `最高 ${format(stats.max.value)}  ${formatTickTime(stats.max.time, span)}` : "";
            const minText = stats ? `最低 ${format(stats.min.value)}  ${formatTickTime(stats.min.time, span)}` : "";
            const extremes = stats
              ? placeExtremeLabels({
                  max: {
                    x: (xPercent(stats.max.time, bounds.from, bounds.to) / 100) * plot.width,
                    y: (yPercent(stats.max.value, scale) / 100) * plot.height,
                    width: estimateTextWidth(maxText, 10) + 8,
                  },
                  min: {
                    x: (xPercent(stats.min.time, bounds.from, bounds.to) / 100) * plot.width,
                    y: (yPercent(stats.min.value, scale) / 100) * plot.height,
                    width: estimateTextWidth(minText, 10) + 8,
                  },
                  cursor: cursorBox,
                  plot,
                })
              : null;
            return (
              <>
                <PlotStatic
                  scale={scale}
                  ticks={ticks}
                  bounds={bounds}
                  limits={limits}
                  lineD={lineD}
                  warningD={warningD}
                  criticalD={criticalD}
                  label={describeRow(name, unit, stats, format)}
                />
                {stats && extremes && (
                  <>
                    <Extreme point={stats.max} scale={scale} bounds={bounds} placed={extremes.max} text={maxText} />
                    <Extreme point={stats.min} scale={scale} bounds={bounds} placed={extremes.min} text={minText} />
                  </>
                )}
                <Cursor time={cursor} point={cursorPoint} scale={scale} bounds={bounds} box={cursorBox} text={cursorText} />
              </>
            );
          }}
        </PlotBox>
        <div className="relative min-h-[64px] border-l" style={{ borderColor: "var(--fe-line)" }}>
          {now && (
            <span
              className="absolute left-1.5 right-1 -translate-y-1/2 rounded-sm border-[1.5px] px-1 py-px text-right font-num text-[15px] font-bold"
              style={{ top: `${Math.min(PLOT_BOTTOM, Math.max(PLOT_TOP, yPercent(now.value, scale)))}%`, color, borderColor: color, background: "var(--fe-chrome)" }}
            >
              {/* 札の左に、グラフの最後の点を指す小さな左向きの矢印（札と同じ色）。飾りなので読み上げない */}
              <span
                data-testid="now-tag-arrow"
                aria-hidden="true"
                className="absolute -left-2 top-1/2 -mt-[5px] h-0 w-0 border-y-[5px] border-r-[7px] border-y-transparent"
                style={{ borderRightColor: color }}
              />
              {/* 受信が止まっていても、最後の値は出す（橙で、止まっていると分かるように）。値そのものが無い行だけ「---」 */}
              {format(now.value)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

/** 行の計算結果（データ・範囲・目盛りの数などが変わらなければ、使い回す） */
interface RowModel {
  points: TrendPoint[];
  stats: ReturnType<typeof trendStats>;
  limits: TrendLimit[];
  scale: AxisScale;
  now: TrendPoint | null;
  stale: boolean;
  level: "critical" | "warning" | "normal";
  gapMs: number;
  color: string;
  format: (value: number) => string;
  /** 左の欄・行の上に出す、しきい値の範囲などの文字 */
  sub: string;
  /** 線・しきい値を超えた部分（軽故障・重故障）の SVG の道筋 */
  lineD: string;
  warningD: string;
  criticalD: string;
}

/** 行の重い計算（点・最高最低・目盛り・状態・線の形）。カーソルには依らないので、カーソルが動くたびにはやり直さない */
function buildRowModel(input: {
  data: NonNullable<ReturnType<typeof useDownsampledReadings>["data"]>;
  aggregation: Aggregation;
  sensor: Sensor | undefined;
  latest: Reading | undefined;
  bounds: ResolvedRange;
  live: boolean;
  maxIntervals: number;
  decimals: number | undefined;
  unit: string;
}): RowModel {
  const { data, aggregation, sensor, latest, bounds, live, maxIntervals, decimals, unit } = input;
  // 区間の中央の時刻は、表示の右端（今）より後にしない（最後の区間は、まだ終わっていないため）
  const points = toPoints(data.buckets, data.bucketSeconds, aggregation, bounds.to);
  const stats = trendStats(data.buckets, data.bucketSeconds, points, bounds.to);
  const limits = sensor ? trendLimits(sensor) : [];
  const limitValues = limits.map((limit) => limit.value);
  // 線が無い行（この期間のデータが無い）でも、最後の値が目盛りに収まるようにする
  const extra = stats ? [stats.min.value, stats.max.value] : latest ? [latest.value] : [0, 1];
  const scale = niceScale(Math.min(...extra, ...limitValues), Math.max(...extra, ...limitValues), maxIntervals);
  const bucketMs = data.bucketSeconds * 1000;
  const now = nowPoint(stats?.last ?? null, latest, live);
  // 直近の表示で、最後の受信が古いときは「受信なし」。固定の期間（過去を見ている）ときは判定しない
  const stale = now === null || (live && bounds.to - now.time > staleAfterMs(data.bucketSeconds));
  const level = now ? levelOf(now.value, limits) : "normal";
  // 線をつなぐ長さと、カーソルが点を拾う長さは同じ基準にする（線が見えている所で「データなし」と出さないため）
  const gapMs = gapThreshold(points, bucketMs);
  const color = stateColor(level, stale);
  const limitText = describeLimits(limits);

  let sub = limitText ? `${limitText} ${unit}` : unit || "しきい値なし";
  if (stale && now) sub = `受信なし\u3000最後の値 ${formatLastSeen(now.time)}`;
  if (!stats && !now) sub = "この期間のデータはありません";

  return {
    points,
    stats,
    limits,
    scale,
    now,
    stale,
    level,
    gapMs,
    color,
    format: (value: number) => formatTrendValue(value, scale, decimals),
    sub,
    lineD: linePath(points, scale, bounds.from, bounds.to, gapMs),
    warningD: overPath(points, (v) => levelOf(v, limits) === "warning", scale, bounds.from, bounds.to),
    criticalD: overPath(points, (v) => levelOf(v, limits) === "critical", scale, bounds.from, bounds.to),
  };
}

/**
 * 行のグラフの、動かない部分（目盛りの線・しきい値・線の絵）。カーソルが動いても props は変わらないので、描き直さない（React.memo）。
 * 札（最高・最低・カーソル）は、カーソルに合わせて動くので、ここには含めない。
 */
const PlotStatic = memo(function PlotStatic({
  scale,
  ticks,
  bounds,
  limits,
  lineD,
  warningD,
  criticalD,
  label,
}: {
  scale: AxisScale;
  ticks: number[];
  bounds: ResolvedRange;
  limits: ReadonlyArray<TrendLimit>;
  lineD: string;
  warningD: string;
  criticalD: string;
  label: string;
}) {
  return (
    <>
      <Grid scale={scale} ticks={ticks} bounds={bounds} />
      <LimitLines limits={limits} scale={scale} />
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" role="img" aria-label={label}>
        <path d={lineD} fill="none" style={{ stroke: INK }} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        <path d={warningD} fill="none" style={{ stroke: AMBER }} strokeWidth={2.4} vectorEffect="non-scaling-stroke" />
        <path d={criticalD} fill="none" style={{ stroke: RED }} strokeWidth={2.6} vectorEffect="non-scaling-stroke" />
      </svg>
    </>
  );
});

/** カーソルの時刻の、この行の値を、警報の欄の下の一覧に渡す（何も描かない）。行が消えたら取り下げる */
function CursorValuePublisher({
  widgetId,
  id,
  order,
  name,
  unit,
  value,
  color,
}: {
  widgetId: string;
  id: string;
  order: number;
  name: string;
  unit: string;
  value: string;
  color: string;
}) {
  const setRow = useTrendCursorStore((s) => s.setRow);
  useEffect(() => {
    setRow(widgetId, { id, order, name, unit, value, color });
  }, [widgetId, id, order, name, unit, value, color, setRow]);
  useEffect(() => () => useTrendCursorStore.getState().removeRow(widgetId, id), [widgetId, id]);
  return null;
}

/**
 * 今の値（右端の札・行の色に使う）。直近の表示で、最新の測定値が表示範囲の中にあればそれ、無ければ最後の区間の値。
 * 固定の期間（過去を見ている）ときは、その期間の最後の区間の値。
 */
function nowPoint(lastBucket: TrendPoint | null, latest: Reading | undefined, live: boolean): TrendPoint | null {
  if (!live || !latest) return lastBucket;
  // 表示範囲より前の受信でも、最後に受信した値として出す（呼ぶ側が、古ければ「受信なし」にする）
  return { time: new Date(latest.recordedAt).getTime(), value: latest.value };
}

/** 最後の値の時刻の文字（今日なら時:分、それ以外は月/日 時:分） */
function formatLastSeen(time: number): string {
  const date = new Date(time);
  const hhmm = date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
  return new Date().toDateString() === date.toDateString() ? hhmm : `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
}

/** しきい値の範囲の文字（例: 「範囲 18 〜 28」「上限 1000」）。重故障を優先して出す */
function describeLimits(limits: ReadonlyArray<TrendLimit>): string {
  const pick = (side: TrendLimit["side"]) =>
    limits.find((l) => l.side === side && l.severity === "critical") ?? limits.find((l) => l.side === side);
  const upper = pick("max");
  const lower = pick("min");
  if (upper && lower) return `範囲 ${lower.value} 〜 ${upper.value}`;
  if (upper) return `上限 ${upper.value}`;
  if (lower) return `下限 ${lower.value}`;
  return "";
}

/** 画面読み上げ用の、行の説明 */
function describeRow(name: string, unit: string, stats: ReturnType<typeof trendStats>, format: (v: number) => string): string {
  if (!stats) return `${name}: この期間のデータはありません`;
  return `${name}の推移。今 ${format(stats.last.value)}${unit}、最高 ${format(stats.max.value)}、最低 ${format(stats.min.value)}`;
}

/** 行の左の欄（名前・範囲・数字）。狭い枠では隠す（index.css の trend-stack） */
function RowSide({
  name,
  nameColor = INK,
  sub,
  subColor,
  children,
}: {
  name: string;
  nameColor?: string;
  sub: string;
  subColor: string;
  children?: ReactNode;
}) {
  return (
    <div className="trend-side flex min-w-0 flex-col justify-center border-r px-2.5 py-1.5" style={{ borderColor: "var(--fe-line)" }}>
      <span className="truncate font-bold" style={{ color: nameColor }} title={name}>
        {name}
      </span>
      <span className="truncate font-num text-[11px]" style={{ color: subColor }}>
        {sub}
      </span>
      {children}
    </div>
  );
}

/** 縦軸の目盛りの数字 */
function YAxis({ scale, unit }: { scale: AxisScale; unit: string }) {
  return (
    <div className="relative min-h-[64px] font-num text-[11px]" style={{ color: MUTED }} aria-hidden="true">
      {/* 縦軸の単位。いちばん上の目盛りの数字と重ならないよう、軸の左上の隅に小さく出す */}
      {unit && (
        <span className="absolute left-1 top-0 text-[9px] leading-none" data-testid="trend-y-unit">
          {unit}
        </span>
      )}
      {scale.ticks.map((tick) => (
        <span key={tick} className="absolute right-1.5 -translate-y-1/2" style={{ top: `${yPercent(tick, scale)}%` }}>
          {formatTick(tick, scale)}
        </span>
      ))}
    </div>
  );
}

/** 目盛りの横線と、時間の縦線 */
function Grid({ scale, ticks, bounds }: { scale: AxisScale; ticks: number[]; bounds: ResolvedRange }) {
  return (
    <>
      {scale.ticks.map((tick) => (
        <span key={`y${tick}`} className="absolute inset-x-0 h-px" style={{ top: `${yPercent(tick, scale)}%`, background: "var(--fe-grid)" }} aria-hidden="true" />
      ))}
      {ticks.map((time) => (
        <span key={`x${time}`} className="absolute inset-y-0 w-px" style={{ left: `${xPercent(time, bounds.from, bounds.to)}%`, background: "var(--fe-grid-time)" }} aria-hidden="true" />
      ))}
    </>
  );
}

/**
 * しきい値の点線と、その数値（右端）。軽故障と重故障の両方があるときは、線は 2 本とも引き、
 * 数値は重故障の線にだけ付ける（2 つ並べると文字が重なるため。軽故障しか無い側は、軽故障の線に付ける）。
 */
function LimitLines({ limits, scale }: { limits: ReadonlyArray<TrendLimit>; scale: AxisScale }) {
  return (
    <>
      {limits.map((limit) => {
        const top = `${yPercent(limit.value, scale)}%`;
        const hasCritical = limits.some((other) => other.side === limit.side && other.severity === "critical");
        const labeled = limit.severity === "critical" || !hasCritical;
        return (
          <span key={`${limit.side}${limit.severity}`} aria-hidden="true">
            <span className="absolute inset-x-0 border-t border-dashed" style={{ top, borderColor: CYAN, opacity: limit.severity === "critical" ? 1 : 0.6 }} />
            {labeled && (
              <span
                // 上限の数値は線の上、下限の数値は線の下に出す（行の端で、グラフの線や最高・最低の札と重ならないように）
                className={`absolute right-1 px-1 font-num text-[10px] ${limit.side === "max" ? "-translate-y-[110%]" : "translate-y-[10%]"}`}
                style={{ top, color: CYAN, background: "var(--fe-panel)" }}
              >
                {`${limit.side === "max" ? "上限" : "下限"} ${limit.value}`}
              </span>
            )}
          </span>
        );
      })}
    </>
  );
}

/**
 * 最高・最低の点と、その値・時刻の札。札の位置（box）は呼ぶ側が決める（枠の端で切れない・カーソルの札に重ならない）。
 * どこに置いても重なるとき（placed.faded）は、札を薄くする。
 */
function Extreme({ point, scale, bounds, placed, text }: { point: TrendPoint; scale: AxisScale; bounds: ResolvedRange; placed: PlacedLabel; text: string }) {
  const left = xPercent(point.time, bounds.from, bounds.to);
  const top = yPercent(point.value, scale);
  return (
    <>
      <span
        className="absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px]"
        style={{ left: `${left}%`, top: `${top}%`, borderColor: INK, background: "var(--fe-panel)" }}
        aria-hidden="true"
      />
      <span
        className="pointer-events-none absolute whitespace-nowrap px-1 font-num text-[10px] leading-[14px]"
        style={{ left: placed.box.left, top: placed.box.top, background: "var(--fe-panel)", color: INK, opacity: placed.faded ? 0.25 : 1 }}
        aria-hidden="true"
      >
        {text}
      </span>
    </>
  );
}

/** カーソル（縦線・点・値）。値の札の位置（box）は呼ぶ側が決める（右端・上端で内側に寄る） */
function Cursor({ time, point, scale, bounds, box, text }: { time: number; point: TrendPoint | null; scale: AxisScale; bounds: ResolvedRange; box: LabelBox; text: string }) {
  const left = xPercent(time, bounds.from, bounds.to);
  const top = point ? yPercent(point.value, scale) : 50;
  return (
    <>
      <span className="pointer-events-none absolute inset-y-0 w-px" style={{ left: `${left}%`, background: "var(--fe-cursor)" }} aria-hidden="true" />
      {point && (
        <span
          className="pointer-events-none absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${left}%`, top: `${top}%`, background: INK, boxShadow: "0 0 0 2px var(--fe-panel)" }}
          aria-hidden="true"
        />
      )}
      <span
        className="pointer-events-none absolute whitespace-nowrap rounded-sm px-1.5 font-num text-xs font-bold leading-[18px]"
        style={{ left: box.left, top: box.top, background: INK, color: "var(--fe-panel)" }}
      >
        {text}
      </span>
    </>
  );
}

/**
 * グラフの枠（マウス・指の操作を受ける）。枠の大きさ（px）を測って、中身（札の置き場所の計算）に渡す。
 * 測れない間（描く前・試験の環境）は、標準の大きさ（600×80）で計算する。
 * 枠の要素は最初から出し続ける（測るのは要素ごとに 1 回なので、あとから現れる要素は測れないため）。
 */
function PlotBox({
  pointer,
  children,
}: {
  pointer: PlotPointerHandlers;
  children: (plot: { width: number; height: number }) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const plot = size.width > 0 && size.height > 0 ? size : { width: 600, height: 80 };
  return (
    <div ref={ref} className="relative min-h-[64px] cursor-crosshair overflow-hidden" style={{ touchAction: "pan-y" }} {...pointer}>
      {children(plot)}
    </div>
  );
}
