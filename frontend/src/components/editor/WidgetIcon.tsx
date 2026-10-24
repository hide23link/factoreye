import type { WidgetType } from "../../types";

const PATHS: Record<WidgetType, string[]> = {
  SensorGraph: ["M3 18l5-6 4 3 8-9", "M3 21h18"],
  MultiSensorComparison: ["M3 18l5-6 4 3 8-9", "M3 21h18"],
  StatValue: ["M5 17V9M12 17V5M19 17v-6"],
  Gauge: ["M4 17a8 8 0 0116 0", "M12 17l4-5", "M4 17h16"],
  AlarmAlert: ["M6 17V11a6 6 0 0112 0v6l2 2H4z", "M10 21h4"],
  ProductionStatus: ["M12 4a8 8 0 100 16 8 8 0 000-16z", "M12 8v4l3 2"],
  ProductionPlan: ["M3 20h18", "M5 11h3.5v9H5zM10.5 7H14v13h-3.5zM16 13h3.5v7H16z", "M4 6l5-2 4 2 6-3"],
};

/** ウィジェットの種類を表す小さな絵。装飾なので読み上げない */
export function WidgetIcon({ type, size = 22 }: { type: WidgetType; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[type].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
