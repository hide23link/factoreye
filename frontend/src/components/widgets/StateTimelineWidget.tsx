/**
 * 状態の帯のウィジェット。センサーごとに 1 行、表示期間の「稼働・警報・停止・受信なし」を色の帯で並べ、時間をそろえて見比べる。
 *
 * - 色の意味: 稼働＝落ち着いた緑 ／ 警報＝赤（重故障）・橙（軽故障） ／ 停止＝灰 ／ 受信なし＝橙の斜線
 * - 帯にカーソルを置くと「警報 11:42〜12:58（76 分）」。行の右に稼働率（%）。下に時間の目盛りと、色の見本
 * - 「停止とみなす値」は、設定した行だけ有効（その値以下なら停止）。優先は 受信なし > 警報 > 停止 > 稼働
 * - センサーが多くても重くならないよう、画面に見えた行だけデータを取る（一度見えた行は取り続ける）
 * 表示期間は、グラフと同じ（ダッシュボードの時間操作。ウィジェット個別の期間があればそれ）。
 * 状態の決め方は lib/state-timeline.ts。データは既存の間引き API（センサーごと、約 144 区間）から取る。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "StateTimeline" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーは config.sensorIds、停止とみなす値は config.stateStopValues）。WidgetCard が渡す。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { LIVE_CHART_INTERVAL_MS, useDownsampledReadings, useSensors } from "../../hooks/queries";
import { useElementSize } from "../../hooks/useElementSize";
import { useInView } from "../../hooks/useInView";
import { useNow } from "../../hooks/useNow";
import { effectiveRange, graphSensorIds } from "../../lib/graph-config";
import {
  buildSegments,
  buildTimelineCells,
  describeSegment,
  stateLabel,
  uptimePercent,
  type TimelineSegment,
} from "../../lib/state-timeline";
import { resolveRange } from "../../lib/timeRange";
import { formatTickTime, maxTimeTicks, timeTicks, trendLimits, xPercent } from "../../lib/trend-stack";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import type { Sensor, Widget } from "../../types";
import { ErrorNotice } from "../ErrorNotice";

/** 帯の区間の数（間引き API に頼む区間の数） */
export const TIMELINE_BUCKETS = 144;

/** 帯の色（theme.css の意味の色。暗い・明るいで切り替わる）。受信なしは橙の斜線 */
const NONE_BACKGROUND =
  "repeating-linear-gradient(135deg, var(--fe-amb) 0 2px, transparent 2px 5px)";

function segmentStyle(segment: TimelineSegment): React.CSSProperties {
  const base: React.CSSProperties = { left: `${segment.leftPercent}%`, width: `${segment.widthPercent}%` };
  if (segment.state === "none") return { ...base, backgroundImage: NONE_BACKGROUND, boxShadow: "inset 0 0 0 1px var(--fe-amb)" };
  if (segment.state === "alarm") return { ...base, background: segment.level === "critical" ? "var(--fe-red)" : "var(--fe-amb)" };
  if (segment.state === "stopped") return { ...base, background: "var(--fe-line)" };
  return { ...base, background: "var(--fe-ok)", opacity: 0.75 };
}

interface RowProps {
  sensor: Sensor | undefined;
  sensorId: string;
  /** 停止とみなす値。未設定の行は null */
  stopAt: number | null;
  fromMs: number;
  toMs: number;
}

/** 1 行（センサー名・稼働率・帯）。見えるまでデータを取らない */
const TimelineRow = memo(function TimelineRow({ sensor, sensorId, stopAt, fromMs, toMs }: RowProps) {
  const { ref, inView } = useInView<HTMLDivElement>();
  // 一度見えた行は、画面の外へ出ても取り続ける（スクロールで帯が消えて、取り直さないように）
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (inView) setSeen(true);
  }, [inView]);

  const { data, isError, refetch } = useDownsampledReadings(
    seen ? sensorId : null,
    { from: fromMs, to: toMs },
    TIMELINE_BUCKETS,
    true,
    LIVE_CHART_INTERVAL_MS,
  );
  const name = sensor?.name ?? sensorId;
  const limits = useMemo(() => (sensor ? trendLimits(sensor) : []), [sensor]);
  const cells = useMemo(
    () => (data ? buildTimelineCells(data.buckets, fromMs, toMs, TIMELINE_BUCKETS, limits, stopAt) : null),
    [data, fromMs, toMs, limits, stopAt],
  );
  const segments = useMemo(() => (cells ? buildSegments(cells, fromMs, toMs) : []), [cells, fromMs, toMs]);
  const percent = cells ? uptimePercent(cells) : null;

  let band: React.ReactNode;
  if (!data && isError) {
    band = <ErrorNotice message={`「${name}」の測定値を取得できませんでした。`} onRetry={() => void refetch()} />;
  } else if (!cells) {
    band = <div className="h-5 rounded-[2px]" style={{ background: "var(--fe-grid)" }} aria-label="読み込み中" />;
  } else {
    const summary = segments.map((s) => describeSegment(s)).join("、");
    band = (
      <div
        role="img"
        aria-label={`${name}: 稼働率 ${percent ?? "—"}%。${summary}`}
        className="relative h-5 overflow-hidden rounded-[2px]"
        style={{ background: "var(--fe-grid)" }}
      >
        {segments.map((segment) => (
          <div
            key={segment.startMs}
            className="absolute inset-y-0"
            style={segmentStyle(segment)}
            title={describeSegment(segment)}
          />
        ))}
      </div>
    );
  }

  return (
    <div ref={ref} className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(120px,190px)_minmax(0,1fr)_3.5rem]">
      <span className="truncate font-mono text-sm font-medium" style={{ color: "var(--fe-ink)" }} title={name}>
        {name}
      </span>
      {band}
      <span
        className="font-mono text-xs tabular-nums sm:text-right"
        style={{ color: "var(--fe-mut)" }}
        aria-label={percent === null ? "稼働率 不明" : `稼働率 ${percent}%`}
      >
        {percent === null ? "—" : `${percent}%`}
      </span>
    </div>
  );
});

const LEGEND: Array<{ label: string; style: React.CSSProperties }> = [
  { label: stateLabel("running"), style: { background: "var(--fe-ok)", opacity: 0.75 } },
  { label: stateLabel("alarm", "critical"), style: { background: "var(--fe-red)" } },
  { label: stateLabel("alarm", "warning"), style: { background: "var(--fe-amb)" } },
  { label: stateLabel("stopped"), style: { background: "var(--fe-line)" } },
  { label: stateLabel("none"), style: { backgroundImage: NONE_BACKGROUND, boxShadow: "inset 0 0 0 1px var(--fe-amb)" } },
];

export function StateTimelineWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const now = useNow(LIVE_CHART_INTERVAL_MS);
  const dashboardRange = useTimeRangeStore((s) => s.range);
  const ids = graphSensorIds(widget);
  const resolved = resolveRange(effectiveRange(widget, dashboardRange), now);
  const fromMs = resolved.from;
  const toMs = resolved.to;
  const stopValues = widget.config.stateStopValues ?? {};

  // 時間の目盛りの数は、軸の幅から決める（スマホの狭い幅で、時刻の文字が重ならないように）
  const axisRef = useRef<HTMLDivElement>(null);
  const { width: axisWidth } = useElementSize(axisRef);
  const ticks = useMemo(() => timeTicks(fromMs, toMs, maxTimeTicks(axisWidth)), [fromMs, toMs, axisWidth]);

  if (ids.length === 0) {
    return <p className="text-sm text-gray-500">センサーが設定されていません（編集モードで設定できます）</p>;
  }
  // センサーの一覧（名前・しきい値）が来る前に描くと、警報が稼働に見えてしまう
  if (!sensors) return <p className="text-sm text-gray-500">読み込み中...</p>;

  const span = toMs - fromMs;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto">
      <div className="flex flex-col gap-2">
        {ids.map((id) => (
          <TimelineRow
            key={id}
            sensor={sensors.find((s) => s.id === id)}
            sensorId={id}
            stopAt={stopValues[id] ?? null}
            fromMs={fromMs}
            toMs={toMs}
          />
        ))}
      </div>
      <div className="grid gap-x-3 sm:grid-cols-[minmax(120px,190px)_minmax(0,1fr)_3.5rem]">
        <span className="hidden sm:block" />
        <div ref={axisRef} className="relative h-4 font-mono text-[11px] tabular-nums" style={{ color: "var(--fe-mut)" }} aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${xPercent(tick, fromMs, toMs)}%` }}
            >
              {formatTickTime(tick, span)}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--fe-mut)" }}>
        {LEGEND.map((item) => (
          <span key={item.label}>
            <i className="mr-1 inline-block h-3 w-3 rounded-sm align-[-2px]" style={item.style} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
