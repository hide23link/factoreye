/**
 * 発生中のアラームを一覧にして、確認（既読）できるウィジェット。
 * 発生中（active）と、確認済み（acknowledged）を並べて出す。解決すると自然に一覧から消える。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "AlarmAlert" のときに出す。引数（props）はない。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAlarms, useSensors } from "../../hooks/queries";
import { acknowledgeAlarm } from "../../lib/api";
import { describeActionError } from "../../lib/errors";
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

  const ackError = ackMutation.isError ? describeActionError(ackMutation.error, "アラームの確認") : null;

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

  return (
    <div className="flex h-full flex-col overflow-y-auto text-[13px]">
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
