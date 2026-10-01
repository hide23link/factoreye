import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useSensors } from "../hooks/queries";
import { addWidget } from "../lib/api";
import type { DashboardDetail, WidgetConfig, WidgetType } from "../types";

const WIDGET_TYPES: { value: WidgetType; label: string }[] = [
  { value: "SensorGraph", label: "センサーグラフ" },
  { value: "AlarmAlert", label: "アラーム一覧" },
  { value: "ProductionStatus", label: "稼働ステータス" },
  { value: "MultiSensorComparison", label: "複数センサー比較" },
];

function nextGridPosition(dashboard: DashboardDetail): { gridColumn: number; gridRow: number } {
  if (dashboard.widgets.length === 0) return { gridColumn: 1, gridRow: 1 };
  const maxRow = Math.max(...dashboard.widgets.map((w) => w.gridRow + w.gridHeight - 1));
  return { gridColumn: 1, gridRow: maxRow + 1 };
}

export function AddWidgetModal({
  dashboard,
  onClose,
}: {
  dashboard: DashboardDetail;
  onClose: () => void;
}) {
  const { data: sensors } = useSensors();
  const queryClient = useQueryClient();
  const [type, setType] = useState<WidgetType>("SensorGraph");
  const [sensorId, setSensorId] = useState("");
  const [sensorIds, setSensorIds] = useState<string[]>([]);
  const [color, setColor] = useState("#2563eb");
  const [graphType, setGraphType] = useState<NonNullable<WidgetConfig["graphType"]>>("line");
  const [timeRange, setTimeRange] = useState<NonNullable<WidgetConfig["timeRange"]>>("1h");

  const addMutation = useMutation({
    mutationFn: () => {
      const { gridColumn, gridRow } = nextGridPosition(dashboard);
      const config: WidgetConfig =
        type === "MultiSensorComparison"
          ? { sensorIds, timeRange }
          : type === "SensorGraph"
            ? { color, graphType, timeRange }
            : {};
      return addWidget(dashboard.id, {
        type,
        sensorId: type === "MultiSensorComparison" ? null : sensorId || null,
        gridColumn,
        gridRow,
        gridWidth: 1,
        gridHeight: 1,
        config,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboard.id] });
      onClose();
    },
  });

  const needsSingleSensor = type === "SensorGraph" || type === "ProductionStatus";
  const needsMultiSensor = type === "MultiSensorComparison";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl">
        <h2 className="mb-3 text-lg font-bold">ウィジェットを追加</h2>

        <label className="mb-2 block text-sm">
          種類
          <select
            value={type}
            onChange={(e) => setType(e.target.value as WidgetType)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
          >
            {WIDGET_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {needsSingleSensor && (
          <label className="mb-2 block text-sm">
            センサー
            <select
              value={sensorId}
              onChange={(e) => setSensorId(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            >
              <option value="">選択してください</option>
              {sensors?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {needsMultiSensor && (
          <fieldset className="mb-2 text-sm">
            <legend className="mb-1">比較するセンサー</legend>
            <div className="max-h-32 space-y-1 overflow-y-auto rounded border border-gray-200 p-2">
              {sensors?.map((s) => (
                <label key={s.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sensorIds.includes(s.id)}
                    onChange={(e) =>
                      setSensorIds((prev) =>
                        e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id),
                      )
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {type === "SensorGraph" && (
          <>
            <label className="mb-2 block text-sm">
              グラフ種類
              <select
                value={graphType}
                onChange={(e) =>
                  setGraphType(e.target.value as NonNullable<WidgetConfig["graphType"]>)
                }
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              >
                <option value="line">折れ線</option>
                <option value="bar">棒</option>
                <option value="area">面</option>
              </select>
            </label>
            <label className="mb-2 block text-sm">
              色
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="mt-1 block h-8 w-16"
              />
            </label>
          </>
        )}

        {(type === "SensorGraph" || type === "MultiSensorComparison") && (
          <label className="mb-3 block text-sm">
            期間
            <select
              value={timeRange}
              onChange={(e) =>
                setTimeRange(e.target.value as NonNullable<WidgetConfig["timeRange"]>)
              }
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
            >
              <option value="1h">1時間</option>
              <option value="6h">6時間</option>
              <option value="24h">24時間</option>
              <option value="7d">7日間</option>
            </select>
          </label>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={addMutation.isPending}
            onClick={() => addMutation.mutate()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            追加
          </button>
        </div>
      </div>
    </div>
  );
}
