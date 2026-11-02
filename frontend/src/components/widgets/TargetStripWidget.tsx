/**
 * 達成ストリップのウィジェット。センサーごとに 1 行、一定の間隔（1・5・10 分）を 1 マスにした帯を並べ、
 * そのマスの合計が目標を満たしていれば緑、満たしていなければ赤で見せる。
 *
 * - 受信の確認（ハートビート）: 1 時間あたり 60・間隔 1 分（初期値）。1 分に 1 回の値が来ていれば緑
 * - 生産の目標: 1 時間あたりの目標と間隔を決める。例: 120 個/時・5 分 → 1 マス 10 個以上で緑
 * - 勤務時間の外を「対象外」（灰色）にできる。今の途中のマスは、満たすまで「集計中」（灰色）
 * 計算は lib/target-strip.ts。データは既存の間引き API（センサーごと）から取る。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "TargetStrip" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーの ID と設定を持つ）。WidgetCard が渡す。
 */
import { LIVE_CHART_INTERVAL_MS, useDownsampledReadings, useSensors } from "../../hooks/queries";
import { useNow } from "../../hooks/useNow";
import { graphSensorIds } from "../../lib/graph-config";
import {
  bucketTarget,
  buildCells,
  stripSettingsFromConfig,
  stripWindow,
  summarizeCells,
  type CellState,
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
const formatNumber = (value: number) => (Math.round(value * 10) / 10).toLocaleString("ja-JP");

/** センサー 1 行分（帯と丸印）。センサーごとにデータを取るので、行ごとのコンポーネントにしている。 */
function StripRow({
  widget,
  sensor,
  sensorId,
  window,
  settings,
  nowMs,
}: {
  widget: Widget;
  sensor: Sensor | undefined;
  sensorId: string;
  window: StripWindow;
  settings: StripSettings;
  nowMs: number;
}) {
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
  if (!data) {
    return <p className="text-sm text-gray-400">{name} 読み込み中...</p>;
  }

  const createdAtMs = sensor ? new Date(sensor.createdAt).getTime() : null;
  const cells = buildCells(data.buckets, window, nowMs, settings, widget.config, createdAtMs);
  const summary = summarizeCells(cells);
  const need = bucketTarget(settings.hourlyTarget, settings.bucketMinutes);

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
        aria-label={`${name}: 直近${settings.hours}時間で ${summary.okCount} / ${summary.judged} マスが目標（${formatNumber(need)}）以上`}
        className="flex h-5 min-w-0 gap-px"
      >
        {cells.map((cell) => (
          <div
            key={cell.startMs}
            className={`min-w-px flex-1 rounded-[1px] ${CELL_CLASS[cell.state]}`}
            title={`${timeFormat.format(cell.startMs)}〜 ${CELL_LABEL[cell.state]}（${formatNumber(cell.sum)} / ${formatNumber(need)}）`}
          />
        ))}
      </div>
    </div>
  );
}

export function TargetStripWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const now = useNow(LIVE_CHART_INTERVAL_MS);
  const settings = stripSettingsFromConfig(widget.config);
  const ids = graphSensorIds(widget);

  if (ids.length === 0) {
    return <p className="text-sm text-gray-400">センサーが設定されていません（編集モードで設定できます）</p>;
  }

  const window = stripWindow(now, settings.bucketMinutes, settings.hours);
  const need = bucketTarget(settings.hourlyTarget, settings.bucketMinutes);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
    timeFormat.format(window.from + Math.min(ratio * (window.to - window.from), window.to - window.from - window.bucketMs)),
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto">
      <p className="text-xs text-gray-500">
        1 マス = {settings.bucketMinutes} 分 ／ 目標 {formatNumber(need)} 以上で緑（1 時間あたり {formatNumber(settings.hourlyTarget)}）
      </p>
      <div className="flex flex-col gap-2">
        {ids.map((id) => (
          <StripRow
            key={id}
            widget={widget}
            sensor={sensors?.find((s) => s.id === id)}
            sensorId={id}
            window={window}
            settings={settings}
            nowMs={now}
          />
        ))}
      </div>
      <div className="grid gap-x-3 text-[11px] tabular-nums text-gray-400 sm:grid-cols-[minmax(120px,190px)_minmax(0,1fr)]">
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
