import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useSensors } from "../hooks/queries";
import { addWidget, updateWidget } from "../lib/api";
import type { DashboardDetail, Widget, WidgetConfig, WidgetType } from "../types";

const WIDGET_TYPES: { value: WidgetType; label: string }[] = [
  { value: "SensorGraph", label: "センサーグラフ" },
  { value: "AlarmAlert", label: "アラーム一覧" },
  { value: "ProductionStatus", label: "稼働ステータス" },
  { value: "MultiSensorComparison", label: "複数センサー比較" },
];

// グラフ色のプリセット。普段はここから選ぶだけでよく、細かく指定したい時だけRGB入力に切り替える
const COLOR_PRESETS = [
  { label: "青", value: "#2563eb" },
  { label: "赤", value: "#dc2626" },
  { label: "緑", value: "#16a34a" },
  { label: "オレンジ", value: "#ea580c" },
  { label: "紫", value: "#9333ea" },
  { label: "ティール", value: "#0d9488" },
  { label: "ピンク", value: "#db2777" },
  { label: "グレー", value: "#4b5563" },
];

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v) || 0));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

function nextGridPosition(dashboard: DashboardDetail): { gridColumn: number; gridRow: number } {
  if (dashboard.widgets.length === 0) return { gridColumn: 1, gridRow: 1 };
  const maxRow = Math.max(...dashboard.widgets.map((w) => w.gridRow + w.gridHeight - 1));
  return { gridColumn: 1, gridRow: maxRow + 1 };
}

// <input type="number"> は空文字と数値を行き来するので、フォーム内部では
// "" | number で保持し、送信時にundefined(=auto)へ変換する
type NumOrBlank = number | "";

function toConfigNumber(v: NumOrBlank): number | undefined {
  return v === "" ? undefined : v;
}

export function WidgetFormModal({
  dashboard,
  widget,
  onClose,
}: {
  dashboard: DashboardDetail;
  widget?: Widget;
  onClose: () => void;
}) {
  const isEdit = widget !== undefined;
  const { data: sensors } = useSensors();
  const queryClient = useQueryClient();

  const [type, setType] = useState<WidgetType>(widget?.type ?? "SensorGraph");
  const [sensorId, setSensorId] = useState(widget?.sensorId ?? "");
  const [sensorIds, setSensorIds] = useState<string[]>(widget?.config.sensorIds ?? []);
  const initialColor = widget?.config.color ?? "#2563eb";
  const [color, setColor] = useState(initialColor);
  const [colorMode, setColorMode] = useState<"preset" | "custom">(
    COLOR_PRESETS.some((p) => p.value === initialColor) ? "preset" : "custom",
  );
  const [rgb, setRgb] = useState<[number, number, number]>(() => hexToRgb(initialColor));
  const [graphType, setGraphType] = useState<NonNullable<WidgetConfig["graphType"]>>(
    widget?.config.graphType ?? "line",
  );
  const [timeRangeHours, setTimeRangeHours] = useState<number>(
    widget?.config.timeRangeHours ?? 1,
  );
  const [yAxisMin, setYAxisMin] = useState<NumOrBlank>(widget?.config.yAxisMin ?? "");
  const [yAxisMax, setYAxisMax] = useState<NumOrBlank>(widget?.config.yAxisMax ?? "");

  const buildConfig = (): WidgetConfig =>
    type === "MultiSensorComparison"
      ? {
          sensorIds,
          timeRangeHours,
          yAxisMin: toConfigNumber(yAxisMin),
          yAxisMax: toConfigNumber(yAxisMax),
        }
      : type === "SensorGraph"
        ? {
            color,
            graphType,
            timeRangeHours,
            yAxisMin: toConfigNumber(yAxisMin),
            yAxisMax: toConfigNumber(yAxisMax),
          }
        : {};

  const saveMutation = useMutation({
    mutationFn: () => {
      const config = buildConfig();
      const resolvedSensorId = type === "MultiSensorComparison" ? null : sensorId || null;

      if (isEdit) {
        return updateWidget(widget.id, { sensorId: resolvedSensorId, config });
      }
      const { gridColumn, gridRow } = nextGridPosition(dashboard);
      return addWidget(dashboard.id, {
        type,
        sensorId: resolvedSensorId,
        gridColumn,
        gridRow,
        gridWidth: 4,
        gridHeight: 6,
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
  const needsAxisConfig = type === "SensorGraph" || type === "MultiSensorComparison";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-lg bg-white p-4 shadow-xl">
        <h2 className="mb-3 text-lg font-bold">
          {isEdit ? "ウィジェットを編集" : "ウィジェットを追加"}
        </h2>

        <label className="mb-2 block text-sm">
          種類
          <select
            value={type}
            onChange={(e) => setType(e.target.value as WidgetType)}
            disabled={isEdit}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1 disabled:bg-gray-100"
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
            <div className="mb-2">
              <span className="block text-sm">色</span>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    title={preset.label}
                    aria-label={preset.label}
                    onClick={() => {
                      setColor(preset.value);
                      setColorMode("preset");
                    }}
                    className={
                      color === preset.value && colorMode === "preset"
                        ? "h-6 w-6 rounded-full border-2 border-gray-900"
                        : "h-6 w-6 rounded-full border-2 border-transparent"
                    }
                    style={{ backgroundColor: preset.value }}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setRgb(hexToRgb(color));
                    setColorMode("custom");
                  }}
                  className={
                    colorMode === "custom"
                      ? "rounded bg-gray-900 px-2 py-1 text-xs text-white"
                      : "rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 hover:bg-gray-200"
                  }
                >
                  詳細...
                </button>
              </div>

              {colorMode === "custom" && (
                <div className="mt-2 flex items-end gap-2">
                  {(["R", "G", "B"] as const).map((channel, i) => (
                    <label key={channel} className="text-xs text-gray-500">
                      {channel}
                      <input
                        type="number"
                        min={0}
                        max={255}
                        value={rgb[i]}
                        onChange={(e) => {
                          const next: [number, number, number] = [...rgb];
                          next[i] = Number(e.target.value);
                          setRgb(next);
                          setColor(rgbToHex(...next));
                        }}
                        className="mt-0.5 block w-14 rounded border border-gray-300 px-1 py-0.5"
                      />
                    </label>
                  ))}
                  <span
                    className="mb-0.5 h-6 w-6 rounded border border-gray-300"
                    style={{ backgroundColor: color }}
                  />
                </div>
              )}
            </div>
          </>
        )}

        {needsAxisConfig && (
          <>
            <label className="mb-2 block text-sm">
              横軸: 直近
              <span className="mx-1 inline-flex items-center">
                <input
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={timeRangeHours}
                  onChange={(e) => setTimeRangeHours(Number(e.target.value))}
                  className="w-20 rounded border border-gray-300 px-2 py-1"
                />
              </span>
              時間
            </label>

            <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
              <label>
                縦軸 最小値
                <input
                  type="number"
                  placeholder="自動"
                  value={yAxisMin}
                  onChange={(e) =>
                    setYAxisMin(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                />
              </label>
              <label>
                縦軸 最大値
                <input
                  type="number"
                  placeholder="自動"
                  value={yAxisMax}
                  onChange={(e) =>
                    setYAxisMax(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                />
              </label>
            </div>
          </>
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
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isEdit ? "保存" : "追加"}
          </button>
        </div>
      </div>
    </div>
  );
}
