export interface Sensor {
  id: string;
  name: string;
  ingestKey: string;
  unit: string;
  thresholdMin: number | null;
  thresholdMax: number | null;
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

export type AlarmStatus = "active" | "acknowledged" | "resolved";
export type ThresholdBreached = "min" | "max";

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
}

export type WidgetType = "SensorGraph" | "ProductionStatus" | "AlarmAlert" | "MultiSensorComparison";

export interface WidgetConfig {
  graphType?: "line" | "bar" | "area";
  color?: string;
  // 未指定(undefined)ならRechartsの自動スケール（"auto"）
  yAxisMin?: number;
  yAxisMax?: number;
  // 直近何時間分を表示するか（自由入力、例: 0.5 = 30分、168 = 7日）
  timeRangeHours?: number;
  sensorIds?: string[];
  onThreshold?: number;
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
