import type {
  Alarm,
  Dashboard,
  DashboardDetail,
  Plugin,
  Reading,
  ReadingAggregate,
  Sensor,
  Widget,
  WidgetConfig,
  WidgetType,
} from "../types";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  services: { database: "connected" | "disconnected" };
}

export const fetchHealth = () => request<HealthResponse>("/health");

// ---- Sensors ----
export const fetchSensors = () => request<Sensor[]>("/api/sensors");

export const createSensor = (data: {
  name: string;
  ingestKey: string;
  unit: string;
  thresholdMin?: number | null;
  thresholdMax?: number | null;
}) => request<Sensor>("/api/sensors", { method: "POST", body: JSON.stringify(data) });

export const updateSensor = (
  id: string,
  data: Partial<{
    name: string;
    unit: string;
    thresholdMin: number | null;
    thresholdMax: number | null;
    enabled: boolean;
  }>,
) => request<Sensor>(`/api/sensors/${id}`, { method: "PUT", body: JSON.stringify(data) });

export const deleteSensor = (id: string) =>
  request<void>(`/api/sensors/${id}`, { method: "DELETE" });

// ---- Readings ----
export const fetchSensorReadings = (sensorId: string, from?: string) => {
  const params = new URLSearchParams({ limit: "500" });
  if (from) params.set("from", from);
  return request<{ readings: Reading[]; total: number }>(
    `/api/sensors/${sensorId}/readings?${params.toString()}`,
  );
};

// 時間/日単位の合計値（例: 直近1時間の生産数、本日累計）。生データを全件取得して
// フロントで合算するのではなく、backend側でSUMしたものを受け取る
export const fetchSensorReadingsAggregate = (sensorId: string, from: string, to?: string) => {
  const params = new URLSearchParams({ from });
  if (to) params.set("to", to);
  return request<ReadingAggregate>(
    `/api/sensors/${sensorId}/readings/aggregate?${params.toString()}`,
  );
};

// ---- Alarms ----
export const fetchAlarms = (status?: string) => {
  const params = status ? `?status=${status}` : "";
  return request<{ alarms: Alarm[]; total: number }>(`/api/alarms${params}`);
};

export const acknowledgeAlarm = (alarmId: string, acknowledgedBy: string) =>
  request<Alarm>(`/api/alarms/${alarmId}/ack`, {
    method: "PATCH",
    body: JSON.stringify({ acknowledgedBy }),
  });

// ---- Dashboards ----
export const fetchDashboards = () => request<Dashboard[]>("/api/dashboards");

export const fetchDashboard = (id: string) => request<DashboardDetail>(`/api/dashboards/${id}`);

export const createDashboard = (data: { name: string; description?: string }) =>
  request<DashboardDetail>("/api/dashboards", { method: "POST", body: JSON.stringify(data) });

export const updateDashboard = (id: string, data: { name?: string; description?: string }) =>
  request<DashboardDetail>(`/api/dashboards/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteDashboard = (id: string) =>
  request<void>(`/api/dashboards/${id}`, { method: "DELETE" });

// ---- Widgets ----
export const addWidget = (
  dashboardId: string,
  data: {
    type: WidgetType;
    sensorId?: string | null;
    gridColumn: number;
    gridRow: number;
    gridWidth: number;
    gridHeight: number;
    config: WidgetConfig;
  },
) =>
  request<Widget>(`/api/dashboards/${dashboardId}/widgets`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateWidget = (
  widgetId: string,
  data: Partial<{
    sensorId: string | null;
    gridColumn: number;
    gridRow: number;
    gridWidth: number;
    gridHeight: number;
    config: WidgetConfig;
  }>,
) => request<Widget>(`/api/widgets/${widgetId}`, { method: "PUT", body: JSON.stringify(data) });

export const deleteWidget = (widgetId: string) =>
  request<void>(`/api/widgets/${widgetId}`, { method: "DELETE" });

// ---- Plugins ----
export const fetchPlugins = () => request<Plugin[]>("/api/plugins");

export const enablePlugin = (name: string) =>
  request<Plugin>(`/api/plugins/${name}/enable`, { method: "PATCH" });

export const disablePlugin = (name: string) =>
  request<Plugin>(`/api/plugins/${name}/disable`, { method: "PATCH" });

export const updatePluginConfig = (name: string, config: Record<string, unknown>) =>
  request<Plugin>(`/api/plugins/${name}/config`, {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
