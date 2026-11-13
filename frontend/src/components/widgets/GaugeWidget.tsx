/**
 * 半円のメーター（ゲージ）のウィジェット。いまの値を針で示し、しきい値の範囲を色の帯（緑=正常、橙=軽故障、赤=重故障）で見せる。
 * 数値だけでは分からない「危ない値まで、どれくらい余裕があるか」を、ひと目で分かるようにする。
 * 目盛りの範囲は、しきい値と現在値から自動で決める（設定で手動にもできる）。
 *
 * 【誰が使うか】WidgetCard.tsx が、ウィジェットの種類が "Gauge" のときに出す。
 * 【引数（props）】widget = このウィジェット（センサーの ID や設定を持つ）。WidgetCard が渡す。
 */
import { useSensorReadings, useSensors } from "../../hooks/queries";
import {
  GAUGE_CENTER_X,
  GAUGE_CENTER_Y,
  GAUGE_RADIUS,
  gaugeArcPath,
  gaugeFraction,
  gaugePointAt,
  gaugeRange,
  gaugeZones,
} from "../../lib/gauge";
import { classifySeverity, type Severity } from "../../lib/severity";
import type { Widget } from "../../types";
import { ErrorNotice } from "../ErrorNotice";

// 色の意味は StatValueWidget・ThresholdMeter と同じ（正常=緑、軽故障=橙、重故障=赤）。SVG には色の値（hex）、文字には Tailwind のクラスを使うため、別の形で持つ
const SEVERITY_STYLE: Record<Severity, { color: string; text: string; label: string }> = {
  normal: { color: "#16a34a", text: "text-green-700", label: "🟢 正常" },
  warning: { color: "#d97706", text: "text-amber-700", label: "⚠️ 軽故障のしきい値を超過" },
  critical: { color: "#dc2626", text: "text-red-700", label: "🚨 重故障のしきい値を超過" },
};

/** 目盛りの端の数字。長い小数にならないよう丸める */
function formatEdge(value: number): string {
  return String(Number(value.toPrecision(3)));
}

export function GaugeWidget({ widget }: { widget: Widget }) {
  const { data: sensors } = useSensors();
  const { data, isLoading, isError, refetch } = useSensorReadings(widget.sensorId, 1, 1);
  const sensor = sensors?.find((s) => s.id === widget.sensorId);

  if (!widget.sensorId) {
    return <p className="text-sm text-gray-500">センサーが設定されていません</p>;
  }
  if (!data && isError) {
    return <ErrorNotice message="測定値を取得できませんでした。" onRetry={() => void refetch()} />;
  }
  if (isLoading || !data || !sensor) {
    return <p className="text-sm text-gray-500">読み込み中...</p>;
  }

  const latest = data.readings[0]?.value;
  const range = gaugeRange(sensor, widget.config, latest);
  const zones = gaugeZones(sensor, range);
  const severity = latest === undefined ? "normal" : classifySeverity(latest, sensor);
  const style = SEVERITY_STYLE[severity];
  const decimals = widget.config.decimals ?? 1;
  const fraction = latest === undefined ? null : gaugeFraction(latest, range);
  const [needleX, needleY] = gaugePointAt(fraction ?? 0, GAUGE_RADIUS - 14);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1">
      <p className="max-w-full truncate text-sm font-medium text-gray-600" title={sensor.name}>
        {sensor.name}
      </p>
      <svg viewBox="0 0 200 138" role="img" aria-label={`${sensor.name}: ${latest === undefined ? "データなし" : latest.toFixed(decimals)} ${sensor.unit}`} className="w-full max-w-[260px]">
        {/* 色の帯。薄く敷いたうえで、針の位置までを濃く塗る */}
        {zones.map((zone) => (
          <path key={`${zone.severity}-${zone.from}`} d={gaugeArcPath(zone.from, zone.to)} fill="none" stroke={SEVERITY_STYLE[zone.severity].color} strokeWidth={14} opacity={0.3} />
        ))}
        {fraction !== null &&
          zones.map((zone) => {
            const to = Math.min(zone.to, fraction);
            return to > zone.from ? (
              <path key={`on-${zone.severity}-${zone.from}`} d={gaugeArcPath(zone.from, to)} fill="none" stroke={SEVERITY_STYLE[zone.severity].color} strokeWidth={14} />
            ) : null;
          })}
        {fraction !== null && (
          <>
            <line x1={GAUGE_CENTER_X} y1={GAUGE_CENTER_Y} x2={needleX} y2={needleY} stroke="#111827" strokeWidth={3} strokeLinecap="round" />
            <circle cx={GAUGE_CENTER_X} cy={GAUGE_CENTER_Y} r={5} fill="#111827" />
          </>
        )}
        <text x={GAUGE_CENTER_X - GAUGE_RADIUS} y={116} fontSize={10} textAnchor="middle" fill="#6b7280">
          {formatEdge(range.min)}
        </text>
        <text x={GAUGE_CENTER_X + GAUGE_RADIUS} y={116} fontSize={10} textAnchor="middle" fill="#6b7280">
          {formatEdge(range.max)}
        </text>
        {/* いまの値は、図の中（針の根元の下）に置く。図と一緒に拡縮するので、狭いウィジェットでも針に重ならない */}
        <text x={GAUGE_CENTER_X} y={134} fontSize={24} fontWeight={700} textAnchor="middle" className={`tabular-nums ${style.text}`} fill="currentColor">
          {latest === undefined ? "—" : latest.toFixed(decimals)}
          <tspan fontSize={11} fontWeight={400} dx={3} fill="#6b7280">
            {sensor.unit}
          </tspan>
        </text>
      </svg>
      <span className={`text-xs font-medium ${style.text}`}>{latest === undefined ? "データがありません" : style.label}</span>
    </div>
  );
}
