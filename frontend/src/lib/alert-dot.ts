/**
 * センサー棚のグループ見出しの「状態の点」（未対応のアラームの重さごとの色と説明）。
 *
 * 【誰が使うか】ShelfGroup（機器）、ShelfLineGroup（系統）。
 */
import type { AlertLevel } from "./sensor-groups";

export const LEVEL_DOT: Record<AlertLevel, { className: string; label: string }> = {
  critical: { className: "bg-red-600", label: "重故障のアラームがあります" },
  warning: { className: "bg-amber-500", label: "軽故障のアラームがあります" },
  none: { className: "bg-green-600", label: "未対応のアラームはありません" },
};
