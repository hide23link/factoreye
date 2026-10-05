/**
 * バックエンド API との通信をまとめたモジュール。
 *
 * 画面は、ここの関数だけを呼ぶ（fetch を直接使わない）。
 * - request: 通常の呼び出し。JWT（ログイン）を自動で付け、401 なら一度だけ再発行して再試行する
 * - rawFetch: 認証もリトライもしない、素の呼び出し（再発行そのものに使う）
 * 応答が失敗（HTTP エラー）のときは、例外（Error）を投げる。呼び出し側（React Query 等）が受け止める。
 */
import type {
  Alarm,
  AuthTokens,
  Dashboard,
  DashboardDetail,
  MeResponse,
  MigrationImportResult,
  MigrationStatus,
  NotificationSettings,
  Reading,
  ReadingAggregate,
  Sensor,
  WebhookEventType,
  WebhookSubscription,
  Widget,
  WidgetConfig,
  WidgetType,
} from "../types";
import { getStoredRefreshToken, useAuthStore } from "../store/useAuthStore";

// バックエンドのアドレス。ビルド時に決まる（.env の VITE_API_URL。既定は localhost:8000）
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

// ── 内部: 生リクエスト（認証なし、リトライなし）────────────────
/** 認証もリトライもせず、JSON を送って受け取る。失敗（HTTP エラー）は例外にする。 */
async function rawFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

// 401 時にリフレッシュトークンで再試行する（無限ループ防止のため1回のみ）
let _isRefreshing = false;

/**
 * リフレッシュトークンで、アクセストークンを新しくする。
 * 成功なら true。失敗（期限切れ・トークン無し）なら、ログイン状態を消して false を返す。
 */
async function attemptTokenRefresh(): Promise<boolean> {
  if (_isRefreshing) return false;
  // 管理者が利用者として閲覧中は、再発行しない（期限が切れたら閲覧を終える。
  // 別の利用者のリフレッシュトークンで続けることにならないように）
  if (useAuthStore.getState().impersonation) {
    useAuthStore.getState().clearAuth();
    return false;
  }
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return false;
  _isRefreshing = true;
  try {
    const tokens = await rawFetch<AuthTokens>("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
    useAuthStore.getState().updateTokens(tokens.accessToken, tokens.refreshToken);
    return true;
  } catch {
    useAuthStore.getState().clearAuth();
    return false;
  } finally {
    _isRefreshing = false;
  }
}

// ── 公開: JWT 自動注入 + 401 リトライ ─────────────────────────
/**
 * 通常の API 呼び出し。
 * - アクセストークンがあれば、Authorization ヘッダーに付ける
 * - 401 なら、トークンを再発行して、同じ要求を一度だけ再試行する
 * - 再発行もできなければ、「ログインし直してください」の例外にする
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { accessToken } = useAuthStore.getState();

  const authHeaders: Record<string, string> = {};
  if (accessToken) authHeaders["Authorization"] = `Bearer ${accessToken}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...authHeaders, ...init?.headers },
    ...init,
  });

  if (response.status === 401 && accessToken) {
    const refreshed = await attemptTokenRefresh();
    if (refreshed) {
      const newToken = useAuthStore.getState().accessToken!;
      const retryResponse = await fetch(`${API_BASE_URL}${path}`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${newToken}`,
          ...init?.headers,
        },
        ...init,
      });
      if (!retryResponse.ok) {
        const body = await retryResponse.text();
        throw new Error(`${init?.method ?? "GET"} ${path} failed: ${retryResponse.status} ${body}`);
      }
      if (retryResponse.status === 204) return undefined as T;
      return retryResponse.json() as Promise<T>;
    }
    throw new Error("Session expired. Please log in again.");
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

// ── Auth API (Phase 0.5) ──────────────────────────────────────
// SaaS 版のログイン・登録・利用者の情報（self-hosted では使わない）

export const registerUser = (data: {
  email: string;
  password: string;
  workspaceName: string;
}) => rawFetch<AuthTokens>("/api/auth/register", { method: "POST", body: JSON.stringify(data) });

export const loginUser = (data: { email: string; password: string }) =>
  rawFetch<AuthTokens>("/api/auth/login", { method: "POST", body: JSON.stringify(data) });

export const refreshTokens = (refreshToken: string) =>
  rawFetch<AuthTokens>("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });

export const logoutUser = (refreshToken: string) =>
  rawFetch<void>("/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });

export const fetchMe = (accessToken: string) =>
  rawFetch<MeResponse>("/api/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

// ── Health ────────────────────────────────────────────────────
// バックエンドの死活監視（画面の上部に接続状態を出すため）

export interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  services: { database: "connected" | "disconnected" };
}

export const fetchHealth = () => request<HealthResponse>("/health");

// ── Sensors ───────────────────────────────────────────────────
// センサーの一覧・作成・更新・削除

export const fetchSensors = () => request<Sensor[]>("/api/sensors");

export const createSensor = (data: {
  name: string;
  ingestKey: string;
  unit: string;
  thresholdMinWarning?: number | null;
  thresholdMinCritical?: number | null;
  thresholdMaxWarning?: number | null;
  thresholdMaxCritical?: number | null;
  thresholdDeadBand?: number;
}) => request<Sensor>("/api/sensors", { method: "POST", body: JSON.stringify(data) });

export const updateSensor = (
  id: string,
  data: Partial<{
    name: string;
    unit: string;
    thresholdMinWarning: number | null;
    thresholdMinCritical: number | null;
    thresholdMaxWarning: number | null;
    thresholdMaxCritical: number | null;
    thresholdDeadBand: number;
    enabled: boolean;
  }>,
) => request<Sensor>(`/api/sensors/${id}`, { method: "PUT", body: JSON.stringify(data) });

export const deleteSensor = (id: string) =>
  request<void>(`/api/sensors/${id}`, { method: "DELETE" });

// ── Readings ──────────────────────────────────────────────────
// 測定値の履歴と集計（グラフ・累計に使う）

export const fetchSensorReadings = (sensorId: string, from?: string) => {
  const params = new URLSearchParams({ limit: "500" });
  if (from) params.set("from", from);
  return request<{ readings: Reading[]; total: number }>(
    `/api/sensors/${sensorId}/readings?${params.toString()}`,
  );
};

// 時間/日単位の合計値（例: 直近1時間の生産数、本日累計）
export const fetchSensorReadingsAggregate = (sensorId: string, from: string, to?: string) => {
  const params = new URLSearchParams({ from });
  if (to) params.set("to", to);
  return request<ReadingAggregate>(
    `/api/sensors/${sensorId}/readings/aggregate?${params.toString()}`,
  );
};

// グラフ用の間引き（from〜to を buckets 区間に分け、区間ごとの最小・平均・最大・件数）
export interface DownsampledBucket {
  start: string;
  min: number;
  avg: number;
  max: number;
  count: number;
}

export interface DownsampledReadings {
  bucketSeconds: number;
  buckets: DownsampledBucket[];
}

export const fetchSensorReadingsDownsampled = (
  sensorId: string,
  from: string,
  to: string,
  buckets: number,
) => {
  const params = new URLSearchParams({ from, to, buckets: String(buckets) });
  return request<DownsampledReadings>(
    `/api/sensors/${sensorId}/readings/downsampled?${params.toString()}`,
  );
};

// ── Alarms ────────────────────────────────────────────────────
// アラームの一覧と、確認（既読）の操作

export const fetchAlarms = (status?: string) => {
  const params = status ? `?status=${status}` : "";
  return request<{ alarms: Alarm[]; total: number }>(`/api/alarms${params}`);
};

export const acknowledgeAlarm = (alarmId: string, acknowledgedBy: string) =>
  request<Alarm>(`/api/alarms/${alarmId}/ack`, {
    method: "PATCH",
    body: JSON.stringify({ acknowledgedBy }),
  });

// ── Dashboards ────────────────────────────────────────────────
// ダッシュボードの一覧・作成・更新・削除（削除は論理削除）

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

// ── Widgets ───────────────────────────────────────────────────
// ウィジェットの追加・更新・削除

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

// ── Notification Settings ─────────────────────────────────────
// Discord 通知の設定（送信先 URL、有効/無効、重故障の再通知）

export const fetchNotificationSettings = () =>
  request<NotificationSettings>("/api/settings/notifications");

export const updateNotificationSettings = (data: Partial<NotificationSettings>) =>
  request<NotificationSettings>("/api/settings/notifications", {
    method: "PUT",
    body: JSON.stringify(data),
  });

// ── Webhook Subscriptions（Phase 1: ノーコード連携）─────────────
// Webhook の購読（イベントを、外部サービスの URL へ送る設定）

export const fetchWebhookSubscriptions = () =>
  request<WebhookSubscription[]>("/api/settings/webhooks");

export const createWebhookSubscription = (data: { eventType: WebhookEventType; url: string }) =>
  request<WebhookSubscription>("/api/settings/webhooks", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateWebhookSubscription = (
  id: string,
  data: Partial<{ url: string; enabled: boolean }>,
) =>
  request<WebhookSubscription>(`/api/settings/webhooks/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteWebhookSubscription = (id: string) =>
  request<void>(`/api/settings/webhooks/${id}`, { method: "DELETE" });

// ── Migration（SaaS → OSS。設定画面「データ移行」から使う）──────

export const fetchMigrationStatus = () => request<MigrationStatus>("/api/settings/migration/status");

// SaaS: ログイン中のワークスペースを書き出す（gzip のバイナリなので request() を通さない）
/**
 * ログイン中のワークスペースを書き出す（SaaS 版）。
 * JSON ではなく gzip のバイナリなので、request を通さず fetch で直接受け取り、Blob として返す。
 */
export async function downloadWorkspaceExport(): Promise<Blob> {
  const { accessToken } = useAuthStore.getState();
  const response = await fetch(`${API_BASE_URL}/api/settings/migration/export`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  if (!response.ok) throw new Error(await migrationErrorMessage(response, "書き出し"));
  return response.blob();
}

// self-hosted: 書き出したファイルを取り込む（dryRun のときは件数の確認だけ）
/**
 * 書き出しファイル（gzip）を取り込む（OSS 版）。
 * dryRun: true なら、件数の確認だけ（DB は変わらない）。false なら実際に取り込む。
 * withNotifications: true なら、通知設定も上書きして移す。
 */
export async function importWorkspaceFile(
  file: Blob,
  options: { dryRun: boolean; withNotifications: boolean },
): Promise<MigrationImportResult> {
  const params = new URLSearchParams({
    dry_run: String(options.dryRun),
    with_notifications: String(options.withNotifications),
  });
  const response = await fetch(`${API_BASE_URL}/api/settings/migration/import?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/gzip" },
    body: file,
  });
  if (!response.ok) throw new Error(await migrationErrorMessage(response, "取り込み"));
  return response.json() as Promise<MigrationImportResult>;
}

// サーバーの detail（日本語の理由）があれば、それをそのまま表示する
/**
 * 失敗した応答から、画面に出す文言を取り出す。
 * サーバーが detail（理由の文）を返していれば、それを使う。無ければ「〜に失敗しました（コード）」。
 */
async function migrationErrorMessage(response: Response, action: string): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // JSON でなければ下の汎用メッセージにする
  }
  return `${action}に失敗しました（${response.status}）`;
}
