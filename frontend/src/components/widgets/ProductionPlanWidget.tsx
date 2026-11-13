/**
 * 生産管理のウィジェット。1日の目標に対して、いまどれだけ進んでいるかを見せる。
 *
 * 設定は「1日の目標」だけで動く（勤務時間は初期値 8〜17 時・昼休み 60 分）。
 * - 計画 = 目標 ÷ 稼働時間（休憩を除く）を均等に割ったもの
 * - 表示: 実績/目標、計画との差（先行/遅れ）、達成率、終業時の見込み、稼働率と停止時間、時間別の実績と計画
 *
 * 大きさへの対応: ウィジェットは自由に大きさを変えられ、編集中は画面が狭くなる。
 * 項目の高さを手計算で見積もると、折り返しなどで外れて下が切れるため、実際に描いたあとで
 * はみ出しを測り、はみ出すなら項目を省く（時間別グラフ → 見込み → 稼働率と停止時間の順）。
 *
 * 集計は、勤務時間帯を 10 分ごとに区切った間引きデータ（既存の間引き API）から行う。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "ProductionPlan" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーの ID や設定を持つ）。WidgetCard が渡す。
 */
import { useLayoutEffect, useRef, useState } from "react";

import { LIVE_CHART_INTERVAL_MS, useDownsampledReadings, useSensors } from "../../hooks/queries";
import { useElementSize } from "../../hooks/useElementSize";
import { useNow } from "../../hooks/useNow";
import {
  STOP_BUCKET_MINUTES,
  forecastTone,
  minuteOfDay,
  planTone,
  scheduleFromConfig,
  summarizeProduction,
  type CountBucket,
  type HourRow,
  type PlanTone,
  type ProductionSummary,
  type WorkSchedule,
} from "../../lib/production-plan";
import type { Widget } from "../../types";
import { ErrorNotice } from "../ErrorNotice";

const HOUR_MS = 60 * 60 * 1000;
const BUCKETS_PER_HOUR = 60 / STOP_BUCKET_MINUTES;

/** はみ出したときに省く項目の段階。0=すべて、1=時間別グラフなし、2=見込みもなし、3=稼働率と停止時間もなし */
const MAX_TRIM_LEVEL = 3;

const TONE_TEXT: Record<PlanTone, string> = { ok: "text-green-600", warn: "text-amber-600", crit: "text-red-600" };
const TONE_CHIP: Record<PlanTone, string> = {
  ok: "bg-green-100 text-green-700",
  warn: "bg-amber-100 text-amber-700",
  crit: "bg-red-100 text-red-700",
};

const formatNumber = (value: number) => Math.round(value).toLocaleString("ja-JP");

/** 今日の 0 時（ローカル時間）のミリ秒 */
function startOfDay(timeMs: number): number {
  const d = new Date(timeMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 間引きデータの1区間を、10 分区間の生産数にする。区間の合計 = 平均 × 件数 */
function toCountBucket(bucket: { start: string; avg: number; count: number }): CountBucket {
  const minute = minuteOfDay(new Date(bucket.start).getTime());
  return {
    // 区間の開始は秒の端数がずれることがあるので、10 分の倍数に丸める
    startMinute: Math.round(minute / STOP_BUCKET_MINUTES) * STOP_BUCKET_MINUTES,
    count: Math.round(bucket.avg * bucket.count),
  };
}

/** 生産管理ウィジェット本体（データの取得と、省く項目の判定）。 */
export function ProductionPlanWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const sensor = sensors?.find((s) => s.id === widget.sensorId);
  const now = useNow(LIVE_CHART_INTERVAL_MS);
  const schedule = scheduleFromConfig(widget.config);
  const target = widget.config.dailyTarget ?? 0;

  const dayStart = startOfDay(now);
  const range = {
    from: dayStart + schedule.startHour * HOUR_MS,
    to: dayStart + schedule.endHour * HOUR_MS,
  };
  const bucketCount = (schedule.endHour - schedule.startHour) * BUCKETS_PER_HOUR;
  const { data, isError, refetch } = useDownsampledReadings(widget.sensorId, range, bucketCount, true);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-500">センサーが設定されていません</p>;
  }
  if (!data && isError) {
    return <ErrorNotice message="測定値を取得できませんでした。" onRetry={() => void refetch()} />;
  }
  if (!data) {
    return <p className="text-sm text-gray-500">読み込み中...</p>;
  }
  if (!(target > 0)) {
    return <p className="text-sm text-gray-500">1日の目標が設定されていません（編集モードで設定できます）</p>;
  }

  const summary = summarizeProduction(target, schedule, data.buckets.map(toCountBucket), minuteOfDay(now));
  return (
    <ProductionPlanView
      title={`生産管理 ${sensor?.name ?? ""}`.trim()}
      unit={sensor?.unit || "個"}
      summary={summary}
      schedule={schedule}
      show={{
        hourly: widget.config.showHourly ?? true,
        forecast: widget.config.showForecast ?? true,
        uptime: widget.config.showUptime ?? true,
      }}
    />
  );
}

interface ViewProps {
  title: string;
  unit: string;
  summary: ProductionSummary;
  schedule: WorkSchedule;
  /** 表示したい項目（実際には、入りきらないものは省く） */
  show: { hourly: boolean; forecast: boolean; uptime: boolean };
}

/** 表示の本体。入りきらない項目を、描いたあとの実測で省く。 */
function ProductionPlanView({ title, unit, summary, show }: ViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(rootRef);

  // 大きさ・表示項目が変わったら、省く段階を 0 からやり直す。
  // 「やり直し」を effect で state に書くと 1 回余計に描くため、条件が変わったことを key で見分けて導く
  const fitKey = `${width}x${height}:${show.hourly}${show.forecast}${show.uptime}`;
  const [trim, setTrim] = useState({ key: fitKey, level: 0 });
  const level = trim.key === fitKey ? trim.level : 0;

  // 描いた直後（画面に出る前）に、はみ出しを測る。はみ出していれば、項目を1段階省いてもう一度描く
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || level >= MAX_TRIM_LEVEL) return;
    if (el.scrollHeight > el.clientHeight + 1) setTrim({ key: fitKey, level: level + 1 });
    // summary: 数字の桁が増えて折り返すなど、データが変わって高さが変わる場合にも測り直す
  }, [level, fitKey, summary]);

  const showHourly = show.hourly && level < 1;
  const showForecast = show.forecast && level < 2;
  const showUptime = show.uptime && level < 3;

  const diffTone = planTone(summary.diff, summary.target);
  const diffText =
    summary.diff >= 0
      ? `計画より ${formatNumber(summary.diff)} ${unit} 先行`
      : `計画より ${formatNumber(-summary.diff)} ${unit} 遅れ`;

  return (
    <div ref={rootRef} className="h-full overflow-hidden">
      <div ref={contentRef} data-testid="production-plan-content" className="flex h-full flex-col gap-2 overflow-hidden">
        <p className="truncate text-sm font-medium text-gray-700">{title}</p>

        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
          <p className="text-3xl font-extrabold leading-none text-gray-900">
            {formatNumber(summary.actual)}
            <small className="ml-1 text-sm font-medium text-gray-500">
              / {formatNumber(summary.target)} {unit}
            </small>
          </p>
          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${TONE_CHIP[diffTone]}`}>{diffText}</span>
        </div>

        <ProgressBar summary={summary} />

        <div className="grid grid-cols-[repeat(auto-fit,minmax(86px,1fr))] gap-2">
          <Kpi label="達成率" value={`${Math.round(summary.achievementPercent)}%`} />
          {showForecast && (
            <Kpi
              label="終業時の見込み"
              value={summary.forecast === null ? "—" : formatNumber(summary.forecast)}
              note={summary.forecastPercent === null ? "始業直後は出しません" : `(${Math.round(summary.forecastPercent)}%)`}
              tone={summary.forecastPercent === null ? undefined : forecastTone(summary.forecastPercent)}
            />
          )}
          {showUptime && (
            <>
              <Kpi label="稼働率" value={summary.uptimePercent === null ? "—" : `${summary.uptimePercent}%`} />
              <Kpi label="停止時間" value={String(summary.stopMinutes)} note="分" />
            </>
          )}
        </div>

        {showHourly && <HourlyChart hours={summary.hours} />}
      </div>
    </div>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: PlanTone }) {
  return (
    <div className="rounded-lg bg-gray-50 px-2.5 py-1.5">
      <span className="block text-[11px] text-gray-500">{label}</span>
      <b className={`text-lg ${tone ? TONE_TEXT[tone] : "text-gray-900"}`}>{value}</b>
      {note && <span className="ml-1 text-xs text-gray-500">{note}</span>}
    </div>
  );
}

/** 実績の進み具合（青）と、いま時点の計画（黒い線） */
function ProgressBar({ summary }: { summary: ProductionSummary }) {
  const actualPercent = Math.min(100, summary.achievementPercent);
  const planPercent = summary.target > 0 ? Math.min(100, (summary.planNow / summary.target) * 100) : 0;
  return (
    <div
      className="relative mt-3 h-3 shrink-0 rounded-full border border-gray-200 bg-gray-50"
      role="img"
      aria-label={`実績 ${Math.round(summary.achievementPercent)}%、いま時点の計画 ${Math.round(planPercent)}%`}
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-blue-600" style={{ width: `${actualPercent}%` }} />
      <div className="absolute -bottom-1 -top-1 w-0.5 bg-gray-900" style={{ left: `${planPercent}%` }}>
        <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-gray-500">
          計画 {formatNumber(summary.planNow)}
        </span>
      </div>
    </div>
  );
}

// 時間別グラフの余白（下に時刻の文字を置く）
const CHART_LABEL_HEIGHT = 16;
const CHART_MIN_HEIGHT = 72;

/** 時間別の実績（棒）と計画（枠線）。計画に届かなかった時間は橙。広がれる分だけ縦に広がる */
function HourlyChart({ hours }: { hours: HourRow[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const plotHeight = Math.max(0, height - CHART_LABEL_HEIGHT);
  const max = Math.max(1, ...hours.map((h) => Math.max(h.plan, h.actual))) * 1.1;
  const slot = hours.length > 0 ? width / hours.length : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ minHeight: CHART_MIN_HEIGHT }}>
      <div className="flex gap-3 text-[11px] text-gray-500">
        時間別の実績
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-full bg-blue-600" /> 実績
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-full border border-gray-900" /> 計画
        </span>
      </div>
      <div ref={boxRef} className="relative min-h-0 flex-1">
        <svg
          className="absolute inset-0"
          width={width}
          height={height}
          role="img"
          aria-label="時間別の実績と計画"
        >
          {width > 0 &&
            hours.map((h, i) => {
              const x = i * slot + slot * 0.15;
              const barWidth = slot * 0.7;
              const label = (
                <text x={x + barWidth / 2} y={plotHeight + 12} textAnchor="middle" fontSize={10} fill="#6b7280">
                  {h.hour}
                </text>
              );
              if (h.state === "break") {
                return (
                  <g key={h.hour}>
                    <rect x={x} y={plotHeight - 14} width={barWidth} height={14} rx={2} fill="#e5e7eb" />
                    <text x={x + barWidth / 2} y={plotHeight - 3} textAnchor="middle" fontSize={9} fill="#6b7280">
                      休憩
                    </text>
                    {label}
                  </g>
                );
              }
              const actualY = plotHeight - (h.actual / max) * plotHeight;
              const planY = plotHeight - (h.plan / max) * plotHeight;
              // 計画の 97% 未満の時間を橙にする（端数のぶれで、ほぼ計画どおりの時間まで橙にしないため）
              const behind = h.actual < h.plan * 0.97;
              return (
                <g key={h.hour}>
                  {h.state !== "future" && (
                    <rect
                      x={x}
                      y={actualY}
                      width={barWidth}
                      height={plotHeight - actualY}
                      rx={2}
                      fill={behind ? "#d97706" : "#2563eb"}
                      opacity={h.state === "now" ? 0.55 : 1}
                    />
                  )}
                  <rect
                    x={x - 1}
                    y={planY}
                    width={barWidth + 2}
                    height={plotHeight - planY}
                    rx={2}
                    fill="none"
                    stroke="#111827"
                    strokeOpacity={0.55}
                    strokeDasharray={h.state === "future" ? "3 3" : undefined}
                  />
                  {label}
                </g>
              );
            })}
        </svg>
      </div>
    </div>
  );
}
