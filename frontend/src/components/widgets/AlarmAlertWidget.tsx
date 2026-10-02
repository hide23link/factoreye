import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAlarms, useSensors } from "../../hooks/queries";
import { acknowledgeAlarm } from "../../lib/api";

export function AlarmAlertWidget() {
  // 確認済み（acknowledged）は「対応中」なだけで解決はしていないため、active と
  // 合わせて表示する。しきい値内に戻って status=resolved になったら自然に消える
  const { data: activeData, isLoading: activeLoading } = useAlarms("active");
  const { data: ackedData, isLoading: ackedLoading } = useAlarms("acknowledged");
  const { data: sensors } = useSensors();
  const queryClient = useQueryClient();

  const ackMutation = useMutation({
    mutationFn: (alarmId: string) => acknowledgeAlarm(alarmId, "admin"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["alarms"] });
    },
  });

  if (activeLoading || ackedLoading || !activeData || !ackedData) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  const alarms = [...activeData.alarms, ...ackedData.alarms];

  if (alarms.length === 0) {
    return <p className="text-sm text-green-600">現在アラームはありません</p>;
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      {alarms.map((alarm) => {
        const sensor = sensors?.find((s) => s.id === alarm.sensorId);
        const isCritical = alarm.severity === "critical";
        const isAcknowledged = alarm.status === "acknowledged";
        return (
          <div
            key={alarm.id}
            className={
              isCritical
                ? "flex items-center justify-between rounded border border-red-200 bg-red-50 px-2 py-1.5 text-sm"
                : "flex items-center justify-between rounded border border-yellow-200 bg-yellow-50 px-2 py-1.5 text-sm"
            }
          >
            <div>
              <p className={isCritical ? "font-medium text-red-800" : "font-medium text-yellow-800"}>
                {isCritical ? "🚨" : "⚠️"} {sensor?.name ?? "センサー"}
              </p>
              <p className={isCritical ? "text-xs text-red-600" : "text-xs text-yellow-700"}>
                値: {alarm.value} ({alarm.thresholdBreached === "max" ? "上限超過" : "下限未達"})
                {isAcknowledged && "・確認済み（対応中）"}
              </p>
            </div>
            {isAcknowledged ? (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">
                確認済み
              </span>
            ) : (
              <button
                type="button"
                onClick={() => ackMutation.mutate(alarm.id)}
                disabled={ackMutation.isPending}
                className={
                  isCritical
                    ? "rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                    : "rounded bg-yellow-600 px-2 py-1 text-xs text-white hover:bg-yellow-700 disabled:opacity-50"
                }
              >
                確認
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
