/**
 * ウィジェットの追加・編集の小窓。
 * 種類を選ぶと、その種類に必要な項目（センサー、グラフの色、表示範囲、しきい値など）だけを出す。
 * 送信すると、追加は新しい位置（一番下）に、編集は既存の位置のまま保存する。
 *
 * 【誰が使うか】DashboardView.tsx（追加）と WidgetCard.tsx（編集）。
 * 【引数（props）】dashboard = 追加・編集する先のダッシュボード、widget = 編集するウィジェット
 * （省略すると追加になる）、onClose = 閉じるときの処理。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createPortal } from "react-dom";

import { useSensors } from "../hooks/queries";
import { addWidget, updateWidget } from "../lib/api";
import { describeActionError } from "../lib/errors";
import type { DashboardDetail, Widget, WidgetConfig, WidgetType } from "../types";

// ウィジェットの種類の一覧（選択欄の項目）
const WIDGET_TYPES: { value: WidgetType; label: string }[] = [
  { value: "SensorGraph", label: "センサーグラフ" },
  { value: "AlarmAlert", label: "アラーム一覧" },
  { value: "ProductionStatus", label: "稼働ステータス" },
  { value: "MultiSensorComparison", label: "複数センサー比較" },
  { value: "StatValue", label: "数値（Stat）" },
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

/** #RRGGBB の色を、[赤, 緑, 青]（0〜255）に分ける。 */
function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [赤, 緑, 青] を #RRGGBB にする（範囲外は 0〜255 に丸める）。 */
function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v) || 0));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

/** 新しいウィジェットを置く位置。今あるウィジェットの一番下の行の次の行、左端。 */
function nextGridPosition(dashboard: DashboardDetail): { gridColumn: number; gridRow: number } {
  if (dashboard.widgets.length === 0) return { gridColumn: 1, gridRow: 1 };
  const maxRow = Math.max(...dashboard.widgets.map((w) => w.gridRow + w.gridHeight - 1));
  return { gridColumn: 1, gridRow: maxRow + 1 };
}

// <input type="number"> は空文字と数値を行き来するので、フォーム内部では
// "" | number で保持し、送信時にundefined(=auto)へ変換する
type NumOrBlank = number | "";

// 表示時間の既定値（時間）
const DEFAULT_TIME_RANGE_HOURS = 1;

/** 空欄は undefined（自動・未設定）にする。数値はそのまま。 */
function toConfigNumber(v: NumOrBlank): number | undefined {
  return v === "" ? undefined : v;
}

/** ウィジェットの追加・編集の小窓の本体。widget があれば編集、無ければ追加になる。 */
export function WidgetFormModal({
  dashboard,
  widget,
  onClose,
}: {
  dashboard: DashboardDetail;
  widget?: Widget;
  onClose: () => void;
}) {
  // 編集のときは、種類を変えられない（種類ごとに、設定の形が違うため）
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
  const [timeRangeHours, setTimeRangeHours] = useState<NumOrBlank>(
    widget?.config.timeRangeHours ?? 1,
  );
  const [yAxisMin, setYAxisMin] = useState<NumOrBlank>(widget?.config.yAxisMin ?? "");
  const [yAxisMax, setYAxisMax] = useState<NumOrBlank>(widget?.config.yAxisMax ?? "");
  const [onThreshold, setOnThreshold] = useState<NumOrBlank>(widget?.config.onThreshold ?? 0);
  const [dailyTarget, setDailyTarget] = useState<NumOrBlank>(widget?.config.dailyTarget ?? "");
  const [decimals, setDecimals] = useState<NumOrBlank>(widget?.config.decimals ?? 1);

  // 表示時間（時間）。空欄や 0 以下は、既定の 1 時間に戻す（0 だと StatValue が値を出せなくなるため）
  const resolvedTimeRangeHours =
    timeRangeHours !== "" && timeRangeHours > 0 ? timeRangeHours : DEFAULT_TIME_RANGE_HOURS;

  // 種類ごとに、保存する設定（config）の中身を変える。ほかの種類の項目は含めない
  const buildConfig = (): WidgetConfig =>
    type === "MultiSensorComparison"
      ? {
          sensorIds,
          timeRangeHours: resolvedTimeRangeHours,
          yAxisMin: toConfigNumber(yAxisMin),
          yAxisMax: toConfigNumber(yAxisMax),
        }
      : type === "SensorGraph"
        ? {
            color,
            graphType,
            timeRangeHours: resolvedTimeRangeHours,
            yAxisMin: toConfigNumber(yAxisMin),
            yAxisMax: toConfigNumber(yAxisMax),
          }
        : type === "ProductionStatus"
          ? {
              onThreshold: toConfigNumber(onThreshold),
              dailyTarget: toConfigNumber(dailyTarget),
            }
          : type === "StatValue"
            ? {
                timeRangeHours: resolvedTimeRangeHours,
                decimals: toConfigNumber(decimals) ?? 1,
              }
            : {};

  // 保存: 編集なら更新、追加なら新しいウィジェットを作る（成功したら、ダッシュボードを取り直して閉じる）
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

  // 種類ごとに、入力欄を出すかどうか
  const needsSingleSensor =
    type === "SensorGraph" || type === "ProductionStatus" || type === "StatValue";
  const needsMultiSensor = type === "MultiSensorComparison";
  // センサーが要る種類は、選ぶまで保存できない（センサー無しのウィジェットは何も表示しないため）
  const sensorMissing = needsSingleSensor ? sensorId === "" : needsMultiSensor && sensorIds.length === 0;
  const needsAxisConfig = type === "SensorGraph" || type === "MultiSensorComparison";

  // WidgetCard経由（編集時）はreact-grid-layoutのグリッドアイテム（transform指定あり）の
  // 子孫として描画されるため、ここをポータル無しで`position: fixed`にしてもそのtransformが
  // containing blockになってしまい、画面全体ではなくそのウィジェットの範囲内に閉じ込められた
  // 上に他のウィジェット（別のstacking context）の背面に回ってしまう。document.bodyへ
  // portalすることでグリッドのstacking contextから抜け出し、本来のfixedモーダルとして機能させる
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-lg bg-white p-4 shadow-xl">
        <h2 className="mb-3 text-lg font-bold">
          {isEdit ? "ウィジェットを編集" : "ウィジェットを追加"}
        </h2>

        <label className="mb-2 block text-sm">
          種類
          <select
            value={type}
            onChange={(event) => setType(event.target.value as WidgetType)}
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
              onChange={(event) => setSensorId(event.target.value)}
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
                    onChange={(event) =>
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
                onChange={(event) =>
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
                        onChange={(event) => {
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
            <p className="mb-2 text-xs text-gray-500">
              横軸の表示期間は、ダッシュボード上部の時間の操作で変えます（ダッシュボード全体で共通）
            </p>

            <div className="mb-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <label>
                縦軸 最小値
                <input
                  type="number"
                  placeholder="自動"
                  value={yAxisMin}
                  onChange={(event) =>
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
                  onChange={(event) =>
                    setYAxisMax(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                />
              </label>
            </div>
          </>
        )}

        {type === "ProductionStatus" && (
          <>
            <label className="mb-2 block text-sm">
              稼働中とみなす閾値（この値を超えたら「稼働中」表示）
              <input
                type="number"
                value={onThreshold}
                onChange={(event) =>
                  setOnThreshold(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
            <label className="mb-2 block text-sm">
              本日の生産目標数
              <input
                type="number"
                placeholder="未設定（達成率を表示しない）"
                min={0}
                value={dailyTarget}
                onChange={(event) =>
                  setDailyTarget(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
          </>
        )}

        {type === "StatValue" && (
          <>
            <label className="mb-2 block text-sm">
              スパークライン表示: 直近
              <span className="mx-1 inline-flex items-center">
                <input
                  type="number"
                  min={0.1}
                  step={0.5}
                  placeholder={String(DEFAULT_TIME_RANGE_HOURS)}
                  value={timeRangeHours}
                  onChange={(event) =>
                    setTimeRangeHours(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  className="w-20 rounded border border-gray-300 px-2 py-1"
                />
              </span>
              時間
            </label>
            <label className="mb-2 block text-sm">
              小数桁数
              <input
                type="number"
                min={0}
                max={6}
                value={decimals}
                onChange={(event) =>
                  setDecimals(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="mt-1 w-20 rounded border border-gray-300 px-2 py-1"
              />
            </label>
            <p className="mb-2 text-xs text-gray-400">
              色はセンサーの軽故障/重故障しきい値（設定 &gt; センサー管理）に応じて自動で変わります。
            </p>
          </>
        )}

        {sensorMissing && (
          <p className="mt-2 text-xs text-gray-500">
            {needsMultiSensor ? "比較するセンサーを1つ以上選んでください。" : "センサーを選んでください。"}
          </p>
        )}
        {saveMutation.isError && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {describeActionError(saveMutation.error, isEdit ? "ウィジェットの保存" : "ウィジェットの追加")}
          </p>
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
            disabled={saveMutation.isPending || sensorMissing}
            onClick={() => saveMutation.mutate()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isEdit ? "保存" : "追加"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
