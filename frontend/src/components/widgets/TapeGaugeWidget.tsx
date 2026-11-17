/**
 * 計器（帯の目盛り）のウィジェット。操作室の計器のように、今の値を四角で囲んだ大きな数字で出し、
 * その下の目盛りの帯で「しきい値までの余裕」を読む。
 *
 * - 帯: 目盛りの数字・しきい値の印（水色の縦線）・色の帯（橙＝軽故障の外、赤＝重故障の外）・今の値の印（▼）
 * - 桃色の短い線: 今の傾きが 15 分続いたときの位置（予測）
 * - 数字の横: 1 時間あたりの変化（↑ 0.6/h）
 * 目盛りの範囲は、しきい値と今の値のまわり（lib/tape-gauge.ts の tapeRange）。色の帯は、ゲージと同じ決め方（lib/gauge.ts）。
 * 設定で範囲を固定することもできる。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "TapeGauge" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーの ID や設定を持つ）。WidgetCard が渡す。
 */
import { useSensorReadings, useSensors } from "../../hooks/queries";
import { gaugeFraction, gaugeZones } from "../../lib/gauge";
import { classifySeverity, type Severity } from "../../lib/severity";
import { hourlyTrend, predictedValue, tapeRange, tapeTicks } from "../../lib/tape-gauge";
import type { Widget } from "../../types";
import { ErrorNotice } from "../ErrorNotice";

// 直近 1 時間の測定値を取る件数の上限（変化と予測に使う。新しい順）
const TREND_READINGS = 200;

const SEVERITY_COLOR: Record<Severity, string> = { normal: "var(--fe-ink)", warning: "var(--fe-amb)", critical: "var(--fe-red)" };
const ZONE_COLOR: Record<Severity, string> = { normal: "transparent", warning: "var(--fe-amb)", critical: "var(--fe-red)" };

/** 目盛りの数字（長い小数にならないよう丸める） */
function formatTickValue(value: number): string {
  return String(Number(value.toPrecision(4)));
}

export function TapeGaugeWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const { data, isLoading, isError, refetch } = useSensorReadings(widget.sensorId, 1, TREND_READINGS);
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  if (!widget.sensorId) return <p className="text-sm text-gray-500">センサーが設定されていません</p>;
  if (!data && isError) return <ErrorNotice message="測定値を取得できませんでした。" onRetry={() => void refetch()} />;
  if (isLoading || !data || !sensor) return <p className="text-sm text-gray-500">読み込み中...</p>;

  const latest = data.readings[0]?.value;
  const decimals = widget.config.decimals ?? 1;
  const range = tapeRange(sensor, widget.config, latest);
  const zones = gaugeZones(sensor, range);
  const severity = latest === undefined ? "normal" : classifySeverity(latest, sensor);
  const color = SEVERITY_COLOR[severity];
  const trend = latest === undefined ? null : hourlyTrend(data.readings);
  const predicted = latest === undefined ? null : predictedValue(latest, trend);
  const pointer = latest === undefined ? null : gaugeFraction(latest, range);
  const predictedAt = predicted === null ? null : gaugeFraction(predicted, range);
  const percent = (fraction: number) => `${fraction * 100}%`;
  const limits = [sensor.thresholdMinCritical, sensor.thresholdMinWarning, sensor.thresholdMaxWarning, sensor.thresholdMaxCritical].filter(
    (value): value is number => value !== null,
  );

  return (
    <div className="flex h-full flex-col justify-center gap-2 px-1" style={{ background: severity === "critical" ? "var(--fe-red-bg)" : undefined }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-bold" style={{ color: severity === "normal" ? "var(--fe-mut)" : color }} title={sensor.name}>
          {sensor.name}
          {severity === "critical" ? "　重故障のしきい値の外" : severity === "warning" ? "　軽故障のしきい値の外" : ""}
        </span>
        <span className="font-num text-[11px] text-gray-500">{sensor.unit}</span>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="rounded-sm border-[1.5px] px-2 font-num text-[28px] font-bold leading-tight" style={{ color, borderColor: color }}>
          {latest === undefined ? "—" : latest.toFixed(decimals)}
        </span>
        {trend !== null && (
          <span className="font-num text-xs" style={{ color: severity === "normal" ? "var(--fe-mut)" : color }}>
            {trend >= 0 ? "↑" : "↓"}
            {Math.abs(trend).toFixed(decimals)}
            <span className="text-[10px]">/h</span>
          </span>
        )}
      </div>
      {/* 目盛りの帯。高さ 34px: 線・色の帯・印が上の 20px、目盛りの数字が下 */}
      <div
        className="relative mx-2 h-[34px]"
        role="img"
        aria-label={`${sensor.name}: ${latest === undefined ? "データなし" : `${latest.toFixed(decimals)} ${sensor.unit}`}、目盛りは ${formatTickValue(range.min)} から ${formatTickValue(range.max)}`}
      >
        <span className="absolute inset-x-0 top-3 h-px" style={{ background: "var(--fe-mut)" }} />
        {zones
          .filter((zone) => zone.severity !== "normal")
          .map((zone) => (
            <span
              key={`${zone.severity}-${zone.from}`}
              className="absolute top-[9px] h-[7px] opacity-40"
              style={{ left: percent(zone.from), width: percent(zone.to - zone.from), background: ZONE_COLOR[zone.severity] }}
            />
          ))}
        {tapeTicks(range).map((tick) => (
          <span key={tick.value}>
            <span className="absolute top-2 h-[9px] w-px" style={{ left: percent(tick.fraction), background: "var(--fe-mut)" }} />
            <span className="absolute top-5 -translate-x-1/2 font-num text-[10px]" style={{ left: percent(tick.fraction), color: "var(--fe-mut)" }}>
              {formatTickValue(tick.value)}
            </span>
          </span>
        ))}
        {limits.map((value) => {
          const fraction = gaugeFraction(value, range);
          return fraction > 0 && fraction < 1 ? (
            <span key={value} className="absolute top-[3px] -ml-px h-[19px] w-0.5" style={{ left: percent(fraction), background: "var(--fe-cy)" }} aria-hidden="true" />
          ) : null;
        })}
        {pointer !== null && predictedAt !== null && Math.abs(predictedAt - pointer) > 0.004 && (
          <span
            className="absolute top-[11px] h-[3px]"
            style={{ left: percent(Math.min(pointer, predictedAt)), width: percent(Math.abs(predictedAt - pointer)), background: "var(--fe-mag)" }}
            aria-hidden="true"
          />
        )}
        {pointer !== null && (
          <span
            className="absolute top-0 -ml-1.5 h-0 w-0"
            style={{ left: percent(pointer), borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: `10px solid ${color}` }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
