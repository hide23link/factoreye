/**
 * 達成ストリップのウィジェット。センサーごとに 1 行、一定の間隔（1・5・10 分）を 1 マスにした帯を並べ、
 * そのマスの合計が目標を満たしていれば緑、満たしていなければ赤で見せる。
 *
 * - 受信の確認（ハートビート）: 1 時間あたり 60・間隔 1 分（初期値）。1 分に 1 回の値が来ていれば緑
 * - 生産の目標: 1 時間あたりの目標と間隔を決める。例: 120 個/時・5 分 → 1 マス 10 個以上で緑
 * - 勤務時間の外を「対象外」（灰色）にできる。今の途中のマスは、満たすまで「集計中」（灰色）
 * 表示する期間は、グラフと同じ（ダッシュボードの時間操作。ウィジェット個別の期間があればそれ）。
 * 期間が長くてマスが多すぎるときは、マスの長さを自動で広げる（最大 720 マス）。
 * 計算は lib/target-strip.ts。データは既存の間引き API（センサーごと）から取る。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "TargetStrip" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーの ID と設定を持つ）。WidgetCard が渡す。
 */
import { LIVE_CHART_INTERVAL_MS, useDownsampledReadings, useReadingTimes, useSensors } from "../../hooks/queries";
import { useNow } from "../../hooks/useNow";
import { effectiveRange, graphSensorIds } from "../../lib/graph-config";
import { resolveRange } from "../../lib/timeRange";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import {
  bucketTarget,
  buildCells,
  buildIntervalCells,
  formatTargetNumber,
  intervalFetchRange,
  stripSettingsFromConfig,
  stripWindow,
  summarizeCells,
  type CellState,
  type StripCell,
  type StripLevel,
  type StripSettings,
  type StripWindow,
} from "../../lib/target-strip";
import type { Sensor, Widget } from "../../types";
import { ErrorNotice } from "../ErrorNotice";

const CELL_CLASS: Record<CellState, string> = {
  ok: "bg-green-500",
  short: "bg-red-400",
  pending: "bg-gray-200 ring-1 ring-inset ring-gray-300",
  off: "bg-gray-100",
};
const CELL_LABEL: Record<CellState, string> = { ok: "達成", short: "未達", pending: "集計中", off: "対象外" };
const DOT_CLASS: Record<StripLevel, string> = { ok: "bg-green-500", warn: "bg-amber-400", bad: "bg-red-500" };
const DOT_LABEL: Record<StripLevel, string> = { ok: "正常", warn: "未達あり", bad: "未達が続いています" };

const timeFormat = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
const dateTimeFormat = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const formatNumber = formatTargetNumber;

/** 1 行分の見た目（丸印・名前・達成率・帯）。件数の判定と、受信間隔の判定で共通。 */
function StripRowView({
  name,
  cells,
  hoverDetail,
  hours,
}: {
  name: string;
  cells: StripCell[];
  /** マスの hover に出す、判定の説明（例: 「達成（5 / 10）」「受信 1 回」） */
  hoverDetail: (cell: StripCell) => string;
  hours: number;
}) {
  const summary = summarizeCells(cells);
  return (
    <div className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(120px,190px)_minmax(0,1fr)]">
      <div className="flex min-w-0 items-center gap-2">
        <span
          role="img"
          aria-label={DOT_LABEL[summary.level]}
          title={DOT_LABEL[summary.level]}
          className={`h-3 w-3 flex-none rounded-full ${DOT_CLASS[summary.level]}`}
        />
        <span className="truncate font-mono text-sm font-medium text-gray-900" title={name}>
          {name}
        </span>
        <span className="whitespace-nowrap text-xs tabular-nums text-gray-500">
          {summary.percent === null ? "—" : `${summary.percent}%`}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${name}: 表示期間（約 ${formatNumber(hours)} 時間）で ${summary.okCount} / ${summary.judged} マスが達成`}
        className="flex h-5 min-w-0 gap-px"
      >
        {cells.map((cell) => (
          <div
            key={cell.startMs}
            className={`min-w-px flex-1 rounded-[1px] ${CELL_CLASS[cell.state]}`}
            title={`${timeFormat.format(cell.startMs)}〜 ${CELL_LABEL[cell.state]}（${hoverDetail(cell)}）`}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  widget: Widget;
  sensor: Sensor | undefined;
  sensorId: string;
  window: StripWindow;
  settings: StripSettings;
  nowMs: number;
}

/** 件数の判定（生産の目標）。マスの合計が目標以上か。データは間引き API から取る。 */
function CountRow({ widget, sensor, sensorId, window, settings, nowMs }: RowProps) {
  const { data, isError, refetch } = useDownsampledReadings(
    sensorId,
    { from: window.from, to: window.to },
    window.bucketCount,
    true,
    LIVE_CHART_INTERVAL_MS,
  );
  const name = sensor?.name ?? sensorId;
  if (!data && isError) {
    return <ErrorNotice message={`「${name}」の測定値を取得できませんでした。`} onRetry={() => void refetch()} />;
  }
  if (!data) return <p className="text-sm text-gray-500">{name} 読み込み中...</p>;

  const createdAtMs = sensor ? new Date(sensor.createdAt).getTime() : null;
  const cells = buildCells(data.buckets, window, nowMs, settings, widget.config, createdAtMs);
  const need = bucketTarget(settings.hourlyTarget, window.bucketMinutes);
  return (
    <StripRowView
      name={name}
      cells={cells}
      hoverDetail={(cell) => `${formatNumber(cell.sum)} / ${formatNumber(need)}`}
      hours={(window.to - window.from) / HOUR_MS}
    />
  );
}

/** 1 回の取得で読む最大件数（API の上限）。受信が多くて上限に達したときは、古い側を「対象外」にする */
const MAX_READINGS = 10000;
const HOUR_MS = 60 * 60 * 1000;

/** 受信間隔の判定（受信の確認）。前回の受信から上限を超えて受信が無い時間にかかるマスを赤にする。 */
function IntervalRow({ widget, sensor, sensorId, window, settings, nowMs }: RowProps) {
  const fetchRange = intervalFetchRange(window, settings.maxGapSeconds);
  const { data, isError, refetch } = useReadingTimes(sensorId, fetchRange, MAX_READINGS, LIVE_CHART_INTERVAL_MS);
  const name = sensor?.name ?? sensorId;
  if (!data && isError) {
    return <ErrorNotice message={`「${name}」の測定値を取得できませんでした。`} onRetry={() => void refetch()} />;
  }
  if (!data) return <p className="text-sm text-gray-500">{name} 読み込み中...</p>;

  const times = data.readings.map((r) => new Date(r.recordedAt).getTime());
  // 取得は新しい順。上限に達したときは、古い側が欠けているので、読めた最も古い受信より前は判定しない
  const truncatedFrom = data.readings.length >= MAX_READINGS ? Math.min(...times) : null;
  const createdAtMs = sensor ? new Date(sensor.createdAt).getTime() : null;
  const cells = buildIntervalCells(times, window, nowMs, settings, widget.config, createdAtMs, fetchRange.from, truncatedFrom);
  return (
    <StripRowView
      name={name}
      cells={cells}
      hoverDetail={(cell) => `受信 ${cell.sum} 回`}
      hours={(window.to - window.from) / HOUR_MS}
    />
  );
}

export function TargetStripWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const now = useNow(LIVE_CHART_INTERVAL_MS);
  // 表示期間は、グラフと同じ（ダッシュボードの時間範囲。ウィジェット個別の期間があればそれ）
  const dashboardRange = useTimeRangeStore((s) => s.range);
  const settings = stripSettingsFromConfig(widget.config);
  const ids = graphSensorIds(widget);

  if (ids.length === 0) {
    return <p className="text-sm text-gray-500">センサーが設定されていません（編集モードで設定できます）</p>;
  }
  // センサーの一覧（名前・作成時刻）が来る前に描くと、作る前の期間が未達に見え、名前が ID のままになる
  if (!sensors) {
    return <p className="text-sm text-gray-500">読み込み中...</p>;
  }

  const range = resolveRange(effectiveRange(widget, dashboardRange), now);
  const window = stripWindow(range, settings.bucketMinutes);
  const need = bucketTarget(settings.hourlyTarget, window.bucketMinutes);
  const Row = settings.judge === "interval" ? IntervalRow : CountRow;
  // 目盛りは、マスの開始時刻（始め・1/4・半分・3/4）と、右端は表示範囲の終わり（今を越えない）。長い期間は日付も付ける
  const spansDays = range.to - range.from > 24 * 60 * 60 * 1000;
  const tickFormat = spansDays ? dateTimeFormat : timeFormat;
  const ticks = [
    ...[0, 0.25, 0.5, 0.75].map((ratio) => tickFormat.format(window.from + Math.round(ratio * window.bucketCount) * window.bucketMs)),
    tickFormat.format(Math.min(range.to, now)),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto">
      <p className="text-xs text-gray-500">
        1 マス = {window.bucketMinutes} 分{window.bucketMinutes > settings.bucketMinutes ? "（表示期間が長いので自動で広げています）" : ""} ／{" "}
        {settings.judge === "interval"
          ? `前回の受信から ${formatNumber(settings.maxGapSeconds)} 秒以内に次の受信があれば緑`
          : `目標 ${formatNumber(need)} 以上で緑（1 時間あたり ${formatNumber(settings.hourlyTarget)}）`}
      </p>
      <div className="flex flex-col gap-2">
        {ids.map((id) => (
          <Row
            key={id}
            widget={widget}
            sensor={sensors.find((s) => s.id === id)}
            sensorId={id}
            window={window}
            settings={settings}
            nowMs={now}
          />
        ))}
      </div>
      <div className="grid gap-x-3 text-[11px] tabular-nums text-gray-500 sm:grid-cols-[minmax(120px,190px)_minmax(0,1fr)]">
        <span className="hidden sm:block" />
        <div className="flex justify-between">
          {ticks.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-green-500 align-[-2px]" />達成</span>
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-red-400 align-[-2px]" />未達</span>
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-gray-200 align-[-2px] ring-1 ring-inset ring-gray-300" />集計中</span>
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-gray-100 align-[-2px]" />対象外</span>
      </div>
    </div>
  );
}
