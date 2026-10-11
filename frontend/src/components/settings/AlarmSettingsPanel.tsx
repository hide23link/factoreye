/**
 * アラームの一覧と、確認（既読）の操作。
 * 状態（発生中・確認済み・解決済み・すべて）で絞り込める。既定は「発生中」。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useAlarms, useSensors } from "../../hooks/queries";
import { acknowledgeAlarm } from "../../lib/api";
import type { AlarmStatus } from "../../types";
import { ErrorNotice } from "../ErrorNotice";

// 一覧に出す件数の上限（新しい順）。全件は取らない（長く動かした環境で応答が大きくなり、5 秒ごとの取得が重くなるため）
const ALARM_LIST_LIMIT = 100;

// 絞り込みのタブ（"all" は絞らない）
const STATUS_TABS: { value: AlarmStatus | "all"; label: string }[] = [
  { value: "active", label: "発生中" },
  { value: "acknowledged", label: "確認済み" },
  { value: "resolved", label: "解決済み" },
  { value: "all", label: "すべて" },
];

/** アラームの設定パネル（一覧と、確認ボタン）。 */
export function AlarmSettingsPanel() {
  const [statusFilter, setStatusFilter] = useState<AlarmStatus | "all">("active");
  const { data, isLoading, isError, refetch } = useAlarms(
    statusFilter === "all" ? undefined : statusFilter,
    ALARM_LIST_LIMIT,
  );
  const { data: sensors } = useSensors();
  const queryClient = useQueryClient();

  // 「確認」を押したら、アラーム一覧を取り直して表示を更新する
  const ackMutation = useMutation({
    mutationFn: (alarmId: string) => acknowledgeAlarm(alarmId, "admin"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["alarms"] }),
  });

  return (
    <div>
      <h2 className="mb-3 text-lg font-bold text-gray-900">アラーム</h2>

      <div className="mb-3 flex gap-1">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setStatusFilter(tab.value)}
            className={
              statusFilter === tab.value
                ? "rounded bg-gray-900 px-3 py-1 text-xs text-white"
                : "rounded px-3 py-1 text-xs text-gray-500 hover:bg-gray-100"
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-gray-400">読み込み中...</p>}

      {!isLoading && !data && isError && (
        <ErrorNotice message="アラームを取得できませんでした。" onRetry={() => void refetch()} />
      )}

      {data && data.total > data.alarms.length && (
        <p className="mb-2 text-xs text-gray-400">
          新しい順に {data.alarms.length} 件を表示しています（該当は全部で {data.total} 件）。
        </p>
      )}

      {!isLoading && data?.alarms.length === 0 && (
        <p className="text-sm text-gray-400">該当するアラームはありません。</p>
      )}

      {!isLoading && data && data.alarms.length > 0 && (
        <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500">
              <th className="p-2">センサー</th>
              <th className="p-2">重要度</th>
              <th className="p-2">値</th>
              <th className="p-2">超過方向</th>
              <th className="p-2">発生</th>
              <th className="p-2">状態</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {data.alarms.map((alarm) => {
              const sensor = sensors?.find((s) => s.id === alarm.sensorId);
              return (
                <tr key={alarm.id} className="border-b border-gray-100">
                  <td className="p-2 text-sm font-medium text-gray-900">
                    {sensor?.name ?? alarm.sensorId}
                  </td>
                  <td className="p-2 text-sm">
                    {alarm.severity === "critical" ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
                        🚨 重故障
                      </span>
                    ) : (
                      <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">
                        ⚠️ 軽故障
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-sm text-gray-600">{alarm.value}</td>
                  <td className="p-2 text-sm text-gray-600">
                    {alarm.thresholdBreached === "max" ? "上限超過" : "下限未達"}
                  </td>
                  <td className="p-2 text-xs text-gray-400">
                    {new Date(alarm.triggeredAt).toLocaleString("ja-JP")}
                  </td>
                  <td className="p-2 text-sm">
                    {alarm.status === "active" && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
                        発生中
                      </span>
                    )}
                    {alarm.status === "acknowledged" && (
                      <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">
                        確認済み
                      </span>
                    )}
                    {alarm.status === "resolved" && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                        解決済み
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-right">
                    {alarm.status === "active" && (
                      <button
                        type="button"
                        onClick={() => ackMutation.mutate(alarm.id)}
                        disabled={ackMutation.isPending}
                        className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        確認
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
