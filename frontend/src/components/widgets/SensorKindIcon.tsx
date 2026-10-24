/**
 * センサーの種類（計測値・生産数・稼働）を表す小さな絵。装飾なので読み上げない。
 * 数値・稼働ステータスのウィジェットの見出しに添えて、何の値かをひと目で分かるようにする。
 *
 * 【誰が使うか】StatValueWidget、ProductionStatusWidget。
 */
import type { SensorKind } from "../../lib/sensor-kind";

const PATHS: Record<SensorKind, string[]> = {
  // 計測値: メーター
  measure: ["M4 17a8 8 0 0116 0", "M12 17l4-5", "M4 17h16"],
  // 生産数: 箱
  count: ["M4 8l8-4 8 4v8l-8 4-8-4z", "M4 8l8 4 8-4", "M12 12v8"],
  // 稼働: 電源
  state: ["M12 3v8", "M7 6.5a7 7 0 1010 0"],
};

export function SensorKindIcon({ kind, size = 16, className }: { kind: SensorKind; size?: number; className?: string }) {
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
      className={className}
    >
      {PATHS[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
