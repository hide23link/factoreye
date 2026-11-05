/**
 * 最新値を大きく表示するウィジェット（Grafana の Stat パネルを参考にした）。
 * センサーのしきい値を超えると、背景と文字の色を変える。下部には直近の推移（スパークライン）を出す。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "StatValue" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーの ID や設定を持つ）。WidgetCard が渡す。
 */
import { Line, LineChart, ResponsiveContainer } from "recharts";

import { useSensorReadings, useSensors } from "../../hooks/queries";
import { guessSensorKind } from "../../lib/sensor-kind";
import { classifySeverity, type Severity } from "../../lib/severity";
import type { Widget } from "../../types";
import { ErrorNotice } from "../ErrorNotice";
import { SensorKindIcon } from "./SensorKindIcon";
import { ThresholdMeter } from "./ThresholdMeter";

// 状態ごとの見た目（背景、文字、線の色、説明の文言）
const SEVERITY_STYLE: Record<Severity, { bg: string; text: string; accent: string; label: string }> = {
  critical: { bg: "bg-red-50", text: "text-red-700", accent: "#dc2626", label: "🚨 重故障しきい値超過" },
  warning: { bg: "bg-yellow-50", text: "text-yellow-700", accent: "#ca8a04", label: "⚠️ 軽故障しきい値超過" },
  normal: { bg: "bg-gray-50", text: "text-gray-900", accent: "#2563eb", label: "" },
};

// Grafanaの「Stat」パネルを参考にした、最新値を大きく表示するウィジェット。
// センサーのしきい値に応じて色が変わり、下部に直近の推移（スパークライン）を表示する
/** 最新値のウィジェット。最新の測定値（新しい順の先頭）を表示する。 */
export function StatValueWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  // 0 以下（空欄のまま保存された古い設定など）は、既定の 1 時間として扱う
  const configuredHours = widget.config.timeRangeHours;
  const hours = configuredHours !== undefined && configuredHours > 0 ? configuredHours : 1;
  const { data, isLoading, isError, refetch } = useSensorReadings(widget.sensorId, hours);
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-400">センサーが設定されていません</p>;
  }
  if (!data && isError) {
    return <ErrorNotice message="測定値を取得できませんでした。" onRetry={() => void refetch()} />;
  }
  if (isLoading || !data || !sensor) {
    return <p className="text-sm text-gray-400">読み込み中...</p>;
  }

  // 最新の測定値（新しい順なので先頭）。無ければ「—」を出す
  const latest = data.readings[0];
  const decimals = widget.config.decimals ?? 1;
  const severity = latest ? classifySeverity(latest.value, sensor) : "normal";
  const style = SEVERITY_STYLE[severity];
  const sparklineData = [...data.readings].reverse().map((r) => ({ value: r.value }));

  return (
    <div
      className={`flex h-full flex-col items-center justify-center gap-1 rounded p-2 ${style.bg}`}
    >
      <p className="flex max-w-full items-center gap-1.5 text-sm font-medium text-gray-600">
        <SensorKindIcon kind={guessSensorKind(sensor)} className="shrink-0 text-gray-400" />
        <span className="truncate" title={sensor.name}>
          {sensor.name}
        </span>
      </p>
      <p className={`text-4xl font-bold tabular-nums ${style.text}`}>
        {latest ? latest.value.toFixed(decimals) : "—"}
        <span className="ml-1 text-base font-normal text-gray-400">{sensor.unit}</span>
      </p>
      {style.label && <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>}
      {latest && <ThresholdMeter sensor={sensor} value={latest.value} />}
      {/* 推移線は、高さ 40px（数値・しきい値バーで高さが埋まる小さいウィジェットでも、つぶれないよう最低 24px、縮めない） */}
      {sparklineData.length > 1 && (
        <div className="h-10 min-h-6 w-full max-w-[160px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparklineData}>
              <Line
                type="monotone"
                dataKey="value"
                stroke={style.accent}
                dot={false}
                strokeWidth={1.5}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
