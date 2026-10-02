export interface Sensor {
  id: string;
  name: string;
  ingestKey: string;
  unit: string;
  // 軽故障（warning）/重故障（critical）の2段階、上限・下限それぞれ独立してnull許容
  thresholdMinWarning: number | null;
  thresholdMinCritical: number | null;
  thresholdMaxWarning: number | null;
  thresholdMaxCritical: number | null;
  // 不感帯（ヒステリシス）: 閾値付近で値が揺れた際のアラームのチラつきを防ぐ
  thresholdDeadBand: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Reading {
  id: number;
  sensorId: string;
  value: number;
  recordedAt: string;
}

export interface ReadingAggregate {
  sum: number;
  count: number;
}

export type AlarmStatus = "active" | "acknowledged" | "resolved";
export type ThresholdBreached = "min" | "max";
export type AlarmSeverity = "warning" | "critical";

export interface Alarm {
  id: string;
  sensorId: string;
  triggeredAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  value: number;
  status: AlarmStatus;
  thresholdBreached: ThresholdBreached;
  severity: AlarmSeverity;
}

export interface NotificationSettings {
  discordWebhookUrlCritical: string;
  discordWebhookUrlWarning: string;
  enabled: boolean;
  // 重故障のみ: 未解決のまま一定時間（分）経過したら同じアラームを再通知する
  criticalRepeatEnabled: boolean;
  criticalRepeatIntervalMinutes: number;
}

export type WidgetType =
  | "SensorGraph"
  | "ProductionStatus"
  | "AlarmAlert"
  | "MultiSensorComparison"
  | "StatValue";

export interface WidgetConfig {
  graphType?: "line" | "bar" | "area";
  color?: string;
  // 未指定(undefined)ならRechartsの自動スケール（"auto"）
  yAxisMin?: number;
  yAxisMax?: number;
  // 直近何時間分を表示するか（自由入力、例: 0.5 = 30分、168 = 7日）。
  // StatValueWidgetではスパークライン表示用の窓としても使う
  timeRangeHours?: number;
  sensorIds?: string[];
  onThreshold?: number;
  // ProductionStatusWidget用: 本日の生産目標数（未指定なら達成率は表示しない）
  dailyTarget?: number;
  // StatValueWidget用: 表示する小数桁数（未指定なら1桁）
  decimals?: number;
}

export interface Widget {
  id: string;
  dashboardId: string;
  sensorId: string | null;
  type: WidgetType;
  gridColumn: number;
  gridRow: number;
  gridWidth: number;
  gridHeight: number;
  config: WidgetConfig;
  createdAt: string;
  updatedAt: string;
}

export interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  layoutConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardDetail extends Dashboard {
  widgets: Widget[];
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  installedAt: string;
  config: Record<string, unknown>;
}
