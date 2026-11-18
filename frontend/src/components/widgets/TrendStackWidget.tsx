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
 * グラフの上でマウスを動かす（スマホはタップ）と、全行で同じ時刻の縦線と値が出る（カーソル）。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "TrendStack" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーは config.sensorIds、先頭は sensorId にも入る）。WidgetCard が渡す。
 * 表示範囲は、ほかのグラフと同じく画面上部の時間の操作（useTimeRangeStore）に従う。
 */
import { useRef, useState, type PointerEvent, type ReactNode } from "react";

import { useDownsampledReadings, useLatestReadings, useSensors } from "../../hooks/queries";
import { useElementSize } from "../../hooks/useElementSize";
import { useNow } from "../../hooks/useNow";
import { effectiveRange, graphDataOptions, graphSensorIds, type Aggregation } from "../../lib/graph-config";
import { resolveRange, type ResolvedRange } from "../../lib/timeRange";
import {
  formatTick,
  formatTickTime,
  formatTrendValue,
  gapThreshold,
  levelOf,
  linePath,
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
  const bounds = resolveRange(range, now);
  const ids = graphSensorIds(widget);
  // カーソルの時刻（ミリ秒）。null はカーソルを出していないとき
  const [cursor, setCursor] = useState<number | null>(null);

  if (ids.length === 0) {
    return <p className="text-sm text-gray-500">センサーが設定されていません（編集で、センサーをこのウィジェットに入れてください）</p>;
  }

  const span = bounds.to - bounds.from;
  const ticks = timeTicks(bounds.from, bounds.to);
  const pointer = {
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      // 幅が分からない（描く前など）ときは、時刻を決められないので何もしない
      if (box.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      setCursor(bounds.from + ratio * span);
    },
    // マウスが外れたら消す。指（タップ）のときは、離しても残す（値を読むため）
    onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse") setCursor(null);
    },
  };

  return (
    <div className="trend-stack flex h-full min-h-0 flex-col text-[13px]" style={{ color: INK }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-1 pb-1 text-[11px]" style={{ borderColor: "var(--fe-line)", color: MUTED }}>
        <span className="inline-flex items-center gap-1">
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
        <span className="ml-auto font-num" aria-live="polite">
          {cursor === null ? "グラフに触れると、その時刻の値" : `カーソル ${formatTickTime(cursor, span)}`}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {ids.map((id) => (
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
            cursor={cursor}
            ticks={ticks}
            pointer={pointer}
          />
        ))}
      </div>
      <div className="trend-row border-t" style={{ borderColor: "var(--fe-line)" }} aria-hidden="true">
        <span className="trend-side" />
        <span />
        <div className="relative h-5 font-num text-[11px]" style={{ color: MUTED }}>
          {ticks.map((time) => (
            <span key={time} className="absolute top-0.5 -translate-x-1/2 whitespace-nowrap" style={{ left: `${xPercent(time, bounds.from, bounds.to)}%` }}>
              {formatTickTime(time, span)}
            </span>
          ))}
        </div>
        <span className="pr-2 pt-0.5 text-right text-[11px]" style={{ color: MUTED }}>
          今
        </span>
      </div>
    </div>
  );
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
  cursor: number | null;
  ticks: number[];
  pointer: {
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerLeave: (event: PointerEvent<HTMLDivElement>) => void;
  };
}

/** 1 センサー分の行。データの取得（間引き）は行ごとに行う */
function TrendRow({ sensorId, sensor, latest, bounds, live, refreshMs, aggregation, decimals, cursor, ticks, pointer }: RowProps) {
  const { data, isError, refetch } = useDownsampledReadings(sensorId, bounds, GRAPH_BUCKETS, live, refreshMs);
  // 行の高さに合わせて目盛りの数を決める（1 目盛りに 22px 以上。スマホの低い行で数字が重ならないように）
  const rowRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(rowRef);
  const maxIntervals = height > 0 ? Math.min(7, Math.max(2, Math.floor(height / 22))) : 7;
  const name = sensor?.name ?? "センサー";
  const unit = sensor?.unit ?? "";

  if (!data) {
    return (
      <div ref={rowRef} className="trend-row min-h-[72px] flex-1 border-b" style={{ borderColor: "var(--fe-line)" }}>
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
    );
  }

  const points = toPoints(data.buckets, data.bucketSeconds, aggregation);
  const stats = trendStats(data.buckets, data.bucketSeconds, points);
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
  const span = bounds.to - bounds.from;
  const format = (value: number) => formatTrendValue(value, scale, decimals);
  const limitText = describeLimits(limits);

  let sub = limitText ? `${limitText} ${unit}` : unit || "しきい値なし";
  if (stale && now) sub = `受信なし\u3000最後の値 ${formatLastSeen(now.time)}`;
  if (!stats && !now) sub = "この期間のデータはありません";

  const cursorPoint = cursor === null ? null : pointNear(points, cursor, gapMs / 2);
  const rowBackground = !stale && level === "critical" ? "var(--fe-red-row)" : undefined;

  return (
    <div ref={rowRef} className="trend-row min-h-[72px] flex-1 border-b" style={{ borderColor: "var(--fe-line)", background: rowBackground }}>
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
      <YAxis scale={scale} />
      <div className="relative min-h-[64px] cursor-crosshair overflow-hidden" style={{ touchAction: "pan-y" }} {...pointer}>
        <span className="trend-inline-name absolute left-1 top-0.5 z-[1] text-[11px] font-bold" style={{ color: stale || level !== "normal" ? color : INK }}>
          {name}
        </span>
        <Grid scale={scale} ticks={ticks} bounds={bounds} />
        <LimitLines limits={limits} scale={scale} />
        <svg
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label={describeRow(name, unit, stats, format)}
        >
          <path d={linePath(points, scale, bounds.from, bounds.to, gapMs)} fill="none" style={{ stroke: INK }} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
          <path d={overPath(points, (v) => levelOf(v, limits) === "warning", scale, bounds.from, bounds.to)} fill="none" style={{ stroke: AMBER }} strokeWidth={2.4} vectorEffect="non-scaling-stroke" />
          <path d={overPath(points, (v) => levelOf(v, limits) === "critical", scale, bounds.from, bounds.to)} fill="none" style={{ stroke: RED }} strokeWidth={2.6} vectorEffect="non-scaling-stroke" />
        </svg>
        {stats && <Extreme point={stats.max} kind="max" scale={scale} bounds={bounds} text={`最高 ${format(stats.max.value)}  ${formatTickTime(stats.max.time, span)}`} />}
        {stats && <Extreme point={stats.min} kind="min" scale={scale} bounds={bounds} text={`最低 ${format(stats.min.value)}  ${formatTickTime(stats.min.time, span)}`} />}
        {cursor !== null && <Cursor time={cursor} point={cursorPoint} scale={scale} bounds={bounds} text={cursorPoint ? `${format(cursorPoint.value)} ${unit}` : "データなし"} />}
      </div>
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
  );
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
function YAxis({ scale }: { scale: AxisScale }) {
  return (
    <div className="relative min-h-[64px] font-num text-[11px]" style={{ color: MUTED }} aria-hidden="true">
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

/** しきい値の点線と、その数値（右端） */
function LimitLines({ limits, scale }: { limits: ReadonlyArray<TrendLimit>; scale: AxisScale }) {
  return (
    <>
      {limits.map((limit) => {
        const top = `${yPercent(limit.value, scale)}%`;
        const label = `${limit.severity === "critical" ? "重" : "軽"} ${limit.side === "max" ? "上限" : "下限"} ${limit.value}`;
        return (
          <span key={`${limit.side}${limit.severity}`} aria-hidden="true">
            <span className="absolute inset-x-0 border-t border-dashed" style={{ top, borderColor: CYAN, opacity: limit.severity === "critical" ? 1 : 0.6 }} />
            <span className="absolute right-1 -translate-y-[110%] px-1 font-num text-[10px]" style={{ top, color: CYAN, background: "var(--fe-panel)" }}>
              {label}
            </span>
          </span>
        );
      })}
    </>
  );
}

/** 最高・最低の点と、その値・時刻。端では文字を内側に寄せる */
function Extreme({ point, kind, scale, bounds, text }: { point: TrendPoint; kind: "max" | "min"; scale: AxisScale; bounds: ResolvedRange; text: string }) {
  const left = xPercent(point.time, bounds.from, bounds.to);
  const top = yPercent(point.value, scale);
  const shiftX = left > 80 ? "-100%" : left < 10 ? "0%" : "-50%";
  const shiftY = kind === "max" ? "calc(-100% - 5px)" : "6px";
  return (
    <>
      <span
        className="absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px]"
        style={{ left: `${left}%`, top: `${top}%`, borderColor: INK, background: "var(--fe-panel)" }}
        aria-hidden="true"
      />
      <span
        className="pointer-events-none absolute whitespace-nowrap px-1 font-num text-[10px]"
        style={{ left: `${left}%`, top: `${top}%`, transform: `translate(${shiftX}, ${shiftY})`, background: "var(--fe-panel)", color: INK }}
        aria-hidden="true"
      >
        {text}
      </span>
    </>
  );
}

/** カーソル（縦線・点・値）。文字は、右端・上端では内側に寄せる */
function Cursor({ time, point, scale, bounds, text }: { time: number; point: TrendPoint | null; scale: AxisScale; bounds: ResolvedRange; text: string }) {
  const left = xPercent(time, bounds.from, bounds.to);
  const top = point ? yPercent(point.value, scale) : 50;
  const shiftX = left > 70 ? "calc(-100% - 8px)" : "8px";
  const shiftY = top < 30 ? "4px" : "calc(-100% - 4px)";
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
        className="pointer-events-none absolute whitespace-nowrap rounded-sm px-1.5 font-num text-xs font-bold"
        style={{ left: `${left}%`, top: `${top}%`, transform: `translate(${shiftX}, ${shiftY})`, background: INK, color: "var(--fe-panel)" }}
      >
        {text}
      </span>
    </>
  );
}
