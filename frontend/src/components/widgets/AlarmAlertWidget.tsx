import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAlarms, useSensors } from "../../hooks/queries";
import { acknowledgeAlarm } from "../../lib/api";

export function AlarmAlertWidget() {
  const { data, isLoading } = useAlarms("active");
  const { data: sensors } = useSensors();
  const queryClient = useQueryClient();

  const ackMutation = useMutation({
    mutationFn: (alarmId: string) => acknowledgeAlarm(alarmId, "admin"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["alarms"] });
    },
  });

  if (isLoading || !data) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  if (data.alarms.length === 0) {
    return <p className="text-sm text-green-600">現在アラームはありません</p>;
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      {data.alarms.map((alarm) => {
        const sensor = sensors?.find((s) => s.id === alarm.sensorId);
        return (
          <div
            key={alarm.id}
            className="flex items-center justify-between rounded border border-red-200 bg-red-50 px-2 py-1.5 text-sm"
          >
            <div>
              <p className="font-medium text-red-800">{sensor?.name ?? "センサー"}</p>
              <p className="text-xs text-red-600">
                値: {alarm.value} ({alarm.thresholdBreached === "max" ? "上限超過" : "下限未達"})
              </p>
            </div>
            <button
              type="button"
              onClick={() => ackMutation.mutate(alarm.id)}
              disabled={ackMutation.isPending}
              className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
            >
              確認
            </button>
          </div>
        );
      })}
    </div>
  );
}
