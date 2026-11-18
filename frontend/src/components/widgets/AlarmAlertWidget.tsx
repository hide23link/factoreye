/**
 * 発生中のアラームを一覧にして、確認（既読）できるウィジェット。
 * 発生中（active）と、確認済み（acknowledged）を並べて出す。解決すると自然に一覧から消える。
 *
 * 上に見出し「警報・注意」と「すべて確認」ボタン（未確認のものをまとめて確認）。
 * 同じ画面に計器グラフ（TrendStack）があるときは、一覧の下に「カーソルの時刻の値」（計器グラフのカーソルが指す時刻の各センサーの値）と
 * 「色の意味」の凡例を出す。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "AlarmAlert" のときに出す。引数（props）はない。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAlarms, useSensors } from "../../hooks/queries";
import { acknowledgeAlarm } from "../../lib/api";
import { describeActionError } from "../../lib/errors";
import { formatTickTime } from "../../lib/trend-stack";
import { firstTrendCursor, useTrendCursorStore } from "../../store/useTrendCursorStore";
import { ErrorNotice } from "../ErrorNotice";

/** 一覧に出す件数の上限（状態ごと）。新しい順に取る。全件は取らない（応答が大きくなり、サーバーの負荷になるため）。 */
const ALERT_LIMIT = 100;
// 解消済みに出す件数の上限
const RESOLVED_LIMIT = 6;

/** アラームの一覧ウィジェット。センサーの設定は必要ない（全体のアラームを出す）。 */
export function AlarmAlertWidget() {
  // 確認済み（acknowledged）は「対応中」なだけで解決はしていないため、active と
  // 合わせて表示する。しきい値内に戻って status=resolved になったら自然に消える
  const {
    data: activeData,
    isLoading: activeLoading,
    isError: activeError,
    refetch: refetchActive,
  } = useAlarms("active", ALERT_LIMIT);
  const {
    data: ackedData,
    isLoading: ackedLoading,
    isError: ackedError,
    refetch: refetchAcked,
  } = useAlarms("acknowledged", ALERT_LIMIT);
  // 解消済みは参考の表示なので、取れなくても気にしない（isError は見ない）
  const { data: resolvedData } = useAlarms("resolved", RESOLVED_LIMIT);
  const { data: sensors } = useSensors();
  const queryClient = useQueryClient();

  const ackMutation = useMutation({
    mutationFn: (alarmId: string) => acknowledgeAlarm(alarmId, "admin"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["alarms"] });
    },
  });

  // すべて確認: 未確認（発生中）のアラームを、まとめて確認済みにする
  const ackAllMutation = useMutation({
    mutationFn: (alarmIds: string[]) => Promise.all(alarmIds.map((alarmId) => acknowledgeAlarm(alarmId, "admin"))),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["alarms"] });
    },
  });

  const ackError = ackMutation.isError
    ? describeActionError(ackMutation.error, "アラームの確認")
    : ackAllMutation.isError
      ? describeActionError(ackAllMutation.error, "アラームの確認")
      : null;

  if ((!activeData && activeError) || (!ackedData && ackedError)) {
    return (
      <ErrorNotice
        message="アラームを取得できませんでした。"
        onRetry={() => {
          void refetchActive();
          void refetchAcked();
        }}
      />
    );
  }
  if (activeLoading || ackedLoading || !activeData || !ackedData) {
    return <p className="text-sm text-gray-500">読み込み中...</p>;
  }

  // 発生中を先に、確認済みを後に並べる
  const alarms = [...activeData.alarms, ...ackedData.alarms];
  // 解消済み（直近 24 時間）。取れなくても、発生中の一覧は出す（失敗は黙って省く）
  const resolved = (resolvedData?.alarms ?? []).filter((alarm) => alarm.status === "resolved" && isWithinDay(alarm.resolvedAt ?? alarm.triggeredAt));
  const unacknowledgedIds = activeData.alarms.map((alarm) => alarm.id);

  return (
    <div className="flex h-full min-h-0 flex-col text-[13px]">
      {/* 上: 見出し・一覧（足りなければここだけスクロール）。下の「カーソルの時刻の値」と色の意味は、いつも見える */}
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center gap-2 border-b px-2.5 py-1.5" style={{ borderColor: "var(--fe-line)" }}>
        <span className="flex-1 text-[11px] font-bold tracking-wider text-gray-500">警報・注意</span>
        <button
          type="button"
          onClick={() => ackAllMutation.mutate(unacknowledgedIds)}
          disabled={unacknowledgedIds.length === 0 || ackAllMutation.isPending}
          className="rounded border border-gray-300 px-2 py-0.5 text-xs font-bold disabled:opacity-40"
        >
          すべて確認
        </button>
      </div>
      {ackError && (
        <p role="alert" className="px-2 py-1 text-xs text-red-600">
          {ackError}
        </p>
      )}
      {alarms.length === 0 && <p className="px-2 py-2 text-sm" style={{ color: "var(--fe-ok)" }}>現在アラームはありません</p>}
      {alarms.map((alarm) => {
        const sensor = sensors?.find((s) => s.id === alarm.sensorId);
        const isCritical = alarm.severity === "critical";
        const isAcknowledged = alarm.status === "acknowledged";
        const color = isCritical ? "var(--fe-red)" : "var(--fe-amb)";
        return (
          <div
            key={alarm.id}
            className="flex items-start gap-2.5 border-b px-2.5 py-2"
            style={{ borderColor: "var(--fe-line)", background: isCritical && !isAcknowledged ? "var(--fe-red-bg)" : undefined }}
          >
            {/* 印は色だけに頼らない: ▲＝重故障、●＝軽故障 */}
            <span className="font-num font-bold" style={{ color }} aria-hidden="true">
              {isCritical ? "▲" : "●"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold" style={{ color }}>
                {sensor?.name ?? "センサー"}
              </p>
              <p className="font-num text-[11px] text-gray-500">
                {formatAlarmTime(alarm.triggeredAt)}&emsp;値: {alarm.value} ({alarm.thresholdBreached === "max" ? "上限超過" : "下限未達"})
                {isAcknowledged && "・確認済み（対応中）"}
              </p>
            </div>
            {isAcknowledged ? (
              <span className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-500">確認済み</span>
            ) : (
              <button
                type="button"
                onClick={() => ackMutation.mutate(alarm.id)}
                disabled={ackMutation.isPending}
                className="rounded border px-2 py-1 text-xs font-bold disabled:opacity-50"
                style={{ borderColor: color, color }}
              >
                確認
              </button>
            )}
          </div>
        );
      })}
      {resolved.length > 0 && (
        <>
          <p className="border-b px-2.5 py-1.5 text-[11px] font-bold tracking-wider text-gray-500" style={{ borderColor: "var(--fe-line)" }}>
            解消済み（24 時間）
          </p>
          {resolved.slice(0, RESOLVED_LIMIT).map((alarm) => {
            const sensor = sensors?.find((s) => s.id === alarm.sensorId);
            return (
              <div key={alarm.id} className="flex items-start gap-2.5 border-b px-2.5 py-1.5 text-gray-500" style={{ borderColor: "var(--fe-line)" }}>
                <span className="font-num" aria-hidden="true">
                  –
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    {sensor?.name ?? "センサー"} {alarm.thresholdBreached === "max" ? "上限超過" : "下限未達"}
                  </p>
                  <p className="font-num text-[11px]">
                    {formatAlarmTime(alarm.triggeredAt)} — {formatAlarmTime(alarm.resolvedAt ?? alarm.triggeredAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </>
      )}
      </div>
      <CursorValues />
    </div>
  );
}

/** 色の意味の凡例（計器盤の色は、この 6 つの意味だけ） */
const COLOR_MEANINGS: ReadonlyArray<{ color: string; text: string }> = [
  { color: "var(--fe-ink)", text: "白・黒　今の値" },
  { color: "var(--fe-cy)", text: "水色　しきい値" },
  { color: "var(--fe-mag)", text: "桃　目標・予測" },
  { color: "var(--fe-amb)", text: "橙　注意" },
  { color: "var(--fe-red)", text: "赤　警報" },
  { color: "var(--fe-mut)", text: "灰　止まっている" },
];

/**
 * 同じ画面の計器グラフのカーソルが指す時刻の、各センサーの値と、色の意味の凡例。
 * 計器グラフが無い画面（カーソルの時刻が無い）では、何も出さない。
 */
function CursorValues() {
  // 計器グラフが複数あるときは、最初に書き込んだ（先に表示された）計器グラフのカーソルを出す
  const entry = useTrendCursorStore((s) => firstTrendCursor(s.widgets));
  if (!entry || entry.rows.length === 0) return null;
  const { time, spanMs, rows } = entry;

  return (
    // 欄の高さの 3 分の 2 まで。値の行が多いときは、値の一覧だけスクロールし、色の意味は切れない
    <div className="flex max-h-[66%] shrink-0 flex-col">
      <p className="shrink-0 border-y px-2.5 py-1.5 text-[11px] font-bold tracking-wider text-gray-500" style={{ borderColor: "var(--fe-line)" }}>
        カーソル <span className="font-num">{formatTickTime(time, spanMs)}</span> の値
      </p>
      <ul className="min-h-0 overflow-y-auto px-2.5 py-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-baseline gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate" style={{ color: row.color }} title={row.name}>
              {row.name}
            </span>
            <span className="font-num font-bold">{row.value}</span>
            <span className="w-8 font-num text-[11px] text-gray-500">{row.unit}</span>
          </li>
        ))}
      </ul>
      <p className="shrink-0 border-t px-2.5 py-1.5 text-[11px] font-bold tracking-wider text-gray-500" style={{ borderColor: "var(--fe-line)" }}>
        色の意味
      </p>
      <ul className="grid shrink-0 grid-cols-2 gap-x-2 gap-y-0.5 px-2.5 pb-2 text-[11px]">
        {COLOR_MEANINGS.map((meaning) => (
          <li key={meaning.text} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: meaning.color }} aria-hidden="true" />
            {meaning.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 24 時間以内か */
function isWithinDay(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() <= 24 * 3_600_000;
}

/** 時刻の文字（今日なら時:分、それ以外は月/日 時:分。日本時間） */
function formatAlarmTime(iso: string): string {
  const date = new Date(iso);
  const hhmm = date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? hhmm : `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
}
