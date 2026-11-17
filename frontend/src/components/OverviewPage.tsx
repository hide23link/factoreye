/**
 * 全体監視の画面。全部の機器（機器に属さないセンサーは 1 つずつ）を札にして、警報・注意・正常・未受信の欄に並べる。
 * 右には今日の記録（アラームの発生・解消）を新しい順に出す。管制塔で、全部の便の札を並べて見るのと同じ考え方。
 * 状態の決め方は lib/overview.ts。最新の値は 1 回の取得（GET /api/sensors/latest）でまとめて取る。
 *
 * 【誰が使うか】App.tsx が、メニューで「全体監視」を選んだときに出す。引数（props）はない。
 */
import { useQueries } from "@tanstack/react-query";

import { useAlarms, useDashboards, useLatestReadings, useSensors } from "../hooks/queries";
import { fetchDashboard } from "../lib/api";
import { useNow } from "../hooks/useNow";
import { buildStrips, countStates, formatAge, type Strip, type StripState } from "../lib/overview";
import type { Alarm, Sensor, Widget } from "../types";
import { ErrorNotice } from "./ErrorNotice";
import { FloorPlanWidget } from "./widgets/FloorPlanWidget";

// 記録に出す件数（新しい順）
const LOG_LIMIT = 30;

const BAYS: { state: StripState; title: string; color: string }[] = [
  { state: "critical", title: "警報", color: "var(--fe-red)" },
  { state: "warning", title: "注意", color: "var(--fe-amb)" },
  { state: "normal", title: "正常", color: "var(--fe-mut)" },
  { state: "never", title: "未受信", color: "var(--fe-mut)" },
];

/**
 * 配置図のウィジェット（どれかのダッシュボードに置いたもの）。無ければ null。
 * 配置は、ウィジェットの設定として保存されているので、ここでは、その最初の 1 つを探して出す。
 * ダッシュボードの中身は、すでに開いて取っていれば、その取得を使う（キーが同じ）。ここでは取り直し続けない。
 */
function useFloorPlanWidget(): { widget: Widget | null; loading: boolean } {
  const { data: dashboards } = useDashboards();
  const details = useQueries({
    queries: (dashboards ?? []).map((dashboard) => ({
      queryKey: ["dashboard", dashboard.id],
      queryFn: () => fetchDashboard(dashboard.id),
      staleTime: 60_000,
    })),
  });
  // すべての詳細が取れるまで、配置図を選ばない（1 つずつ取れるので、先に取れた後ろの配置図が採用され、のちに入れ替わるのを防ぐ）
  const loading = dashboards === undefined || details.some((detail) => detail.isLoading);
  if (loading) return { widget: null, loading: true };
  for (const detail of details) {
    const found = detail.data?.widgets.find((widget) => widget.type === "FloorPlan");
    if (found) return { widget: found, loading: false };
  }
  return { widget: null, loading: false };
}

/** 全体監視の画面の本体 */
export function OverviewPage() {
  const { widget: floorPlan, loading: floorPlanLoading } = useFloorPlanWidget();
  const sensors = useSensors();
  const latest = useLatestReadings();
  const active = useAlarms("active", 200);
  const acknowledged = useAlarms("acknowledged", 200);
  const recent = useAlarms(undefined, LOG_LIMIT);
  // 「◯ 秒前」を進めるため、10 秒ごとに描き直す
  const now = useNow(10_000);

  if ((!sensors.data && sensors.isError) || (!latest.data && latest.isError)) {
    return (
      <div className="p-4">
        <ErrorNotice
          message="機器の様子を取得できませんでした。"
          onRetry={() => {
            void sensors.refetch();
            void latest.refetch();
          }}
        />
      </div>
    );
  }
  if (!sensors.data || !latest.data) return <p className="p-4 text-sm text-gray-500">読み込み中...</p>;

  const unresolved = [...(active.data?.alarms ?? []), ...(acknowledged.data?.alarms ?? [])];
  const strips = buildStrips(sensors.data, latest.data.readings, unresolved, now);
  const counts = countStates(strips);
  const sensorById = new Map(sensors.data.map((sensor) => [sensor.id, sensor]));

  return (
    <div className="flex flex-col gap-3 p-3 md:p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-bold tracking-wide text-gray-900">全体監視</h1>
        <span className="font-num text-xs text-gray-500">
          札 {strips.length}・センサー {sensors.data.filter((sensor) => sensor.enabled).length}
        </span>
      </div>
      {!floorPlan && !floorPlanLoading && strips.length > 0 && (
        <p className="text-xs text-gray-500">
          ダッシュボードの編集で「配置図」のウィジェットを置くと、ここに配置図が出ます（部屋の枠の上に機器の札を置いて、全部の状態を 1 枚で見られます）。
        </p>
      )}
      {strips.length === 0 ? (
        <p className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-500">
          センサーがまだありません。セットアップガイドから、最初のセンサーを登録してください。
        </p>
      ) : (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          {/* 左: 配置図（管制塔の画面のように、部屋の上に機器の札を置いたもの）。配置図が無いときは、場所を取らず、右だけにする */}
          {floorPlan && (
            <section aria-label="配置図の枠" className="flex min-h-[320px] min-w-0 flex-[3] flex-col rounded border border-gray-200 bg-white p-2.5 lg:h-[560px]">
              <h2 className="mb-1 text-[11px] font-bold tracking-wider text-gray-500">配置図</h2>
              {/* 別のダッシュボードの配置図に替わったときは、編集中の下書きを持ち越さない（key） */}
              <FloorPlanWidget key={floorPlan.id} widget={floorPlan} />
            </section>
          )}
          {/* 右: 機器の札と記録 */}
          <div className="flex min-w-0 flex-[2] flex-col gap-3">
          <section aria-label="機器の札" className="flex min-w-0 flex-col rounded border border-gray-200 bg-white">
            {BAYS.map((bay) => {
              const inBay = strips.filter((strip) => strip.state === bay.state);
              if (inBay.length === 0) return null;
              return (
                <div key={bay.state} className="flex flex-col gap-1 border-b border-gray-200 p-2.5 last:border-b-0">
                  <h2 className="flex justify-between text-[11px] font-bold tracking-wider" style={{ color: bay.color }}>
                    <span>{bay.title}</span>
                    <span className="font-num">{counts[bay.state]}</span>
                  </h2>
                  <ul className="grid gap-1 2xl:grid-cols-2">
                    {inBay.map((strip) => (
                      <li key={strip.key}>
                        <StripCard strip={strip} now={now} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
          <section aria-label="アラームの記録" className="flex min-w-0 flex-col rounded border border-gray-200 bg-white">
            <h2 className="border-b border-gray-200 px-3 py-2 text-[11px] font-bold tracking-wider text-gray-500">記録（アラームの新しい順）</h2>
            <AlarmLog alarms={recent.data?.alarms ?? []} sensorById={sensorById} />
          </section>
          </div>
        </div>
      )}
    </div>
  );
}

const STATE_COLOR: Record<StripState, string> = {
  critical: "var(--fe-red)",
  warning: "var(--fe-amb)",
  normal: "var(--fe-line)",
  never: "var(--fe-line)",
};

/** 1 枚の札。左の色の帯・機器名・値の並び・最後の受信 */
function StripCard({ strip, now }: { strip: Strip; now: number }) {
  const color = STATE_COLOR[strip.state];
  const emphasis = strip.state === "critical" || strip.state === "warning";
  return (
    <div
      className="grid min-h-[46px] grid-cols-[5px_minmax(0,9rem)_minmax(0,1fr)_auto] rounded-sm border bg-gray-100"
      style={{ borderColor: strip.state === "critical" ? color : "var(--fe-line)" }}
    >
      <span style={{ background: color }} aria-hidden="true" />
      <div className="flex min-w-0 flex-col justify-center border-l border-gray-200 px-2 py-1">
        <span className="truncate font-num text-xs font-bold text-gray-900" title={strip.title}>
          {strip.title}
        </span>
        <span className="truncate text-[11px] text-gray-500">{strip.line ?? `センサー ${strip.sensors.length}`}</span>
      </div>
      <div className="flex min-w-0 flex-col justify-center border-l border-gray-200 px-2 py-1">
        {strip.reason && (
          <span className="truncate text-xs font-bold" style={{ color: emphasis ? color : "var(--fe-mut)" }}>
            {strip.reason}
          </span>
        )}
        <span className="truncate font-num text-xs text-gray-700">{describeValues(strip)}</span>
      </div>
      <div className="flex flex-col items-end justify-center border-l border-gray-200 px-2 py-1 font-num text-xs">
        <span style={{ color: strip.reason?.endsWith("受信なし") ? "var(--fe-amb)" : undefined }}>
          {strip.lastTime === null ? "---" : formatAge(now - strip.lastTime)}
        </span>
      </div>
    </div>
  );
}

/** 札に並べる値（例: 「22.4℃ 48% 650ppm」）。多いときは先頭の 4 つと「ほか n」 */
function describeValues(strip: Strip): string {
  const shown = strip.sensors.slice(0, 4).map((item) =>
    item.latest ? `${formatValue(item.latest.value)}${item.sensor.unit}` : `---${item.sensor.unit}`,
  );
  const rest = strip.sensors.length - shown.length;
  return shown.join("\u3000") + (rest > 0 ? `\u3000ほか ${rest}` : "");
}

/** 値の文字（大きな値は小数を省き、小さな値は 2 桁まで） */
function formatValue(value: number): string {
  return Math.abs(value) >= 100 ? String(Math.round(value)) : String(Number(value.toFixed(2)));
}

/** 記録の一覧（時刻・種類・内容）。解消したものは灰色 */
function AlarmLog({ alarms, sensorById }: { alarms: ReadonlyArray<Alarm>; sensorById: Map<string, Sensor> }) {
  if (alarms.length === 0) return <p className="px-3 py-3 text-sm text-gray-500">アラームの記録はありません。</p>;
  return (
    <ol className="flex flex-col">
      {alarms.map((alarm) => {
        const sensor = sensorById.get(alarm.sensorId);
        const resolved = alarm.status === "resolved";
        const kind = resolved ? "解消" : alarm.severity === "critical" ? "警報" : "注意";
        const color = resolved ? "var(--fe-mut)" : alarm.severity === "critical" ? "var(--fe-red)" : "var(--fe-amb)";
        const side = alarm.thresholdBreached === "max" ? "上限超え" : "下限割れ";
        return (
          <li key={alarm.id} className="grid grid-cols-[5.5rem_2.5rem_minmax(0,1fr)] gap-2 border-b border-gray-200 px-3 py-1.5 text-xs last:border-b-0">
            <span className="font-num text-gray-500">{formatLogTime(alarm.triggeredAt)}</span>
            <span className="font-bold" style={{ color }}>
              {kind}
            </span>
            <span className={resolved ? "text-gray-500" : "text-gray-900"}>
              {sensor?.name ?? "削除されたセンサー"} {side} <span className="font-num">{formatValue(alarm.value)}</span>
              {sensor?.unit ?? ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** 記録の時刻（今日なら時:分:秒、それ以外は月/日 時:分） */
function formatLogTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString("ja-JP")
    : date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
