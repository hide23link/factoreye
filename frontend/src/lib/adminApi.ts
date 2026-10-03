// 管理者API（/api/admin）のクライアント。通常ユーザーの lib/api.ts とは別管理。
// トークンは呼び出し側（管理者ストア）が持ち、ここでは保存しない。
import { API_BASE_URL } from "./api";

export class AdminApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

export interface AdminLoginResult {
  accessToken: string;
  tokenType: string;
}

export interface AdminOverview {
  userCount: number;
  workspaceCount: number;
  sensorCount: number;
  readingCount: number;
  databaseSizeBytes: number;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  createdAt: string;
  workspaceId: string | null;
  workspaceName: string | null;
  plan: string | null;
  sensorCount: number;
  readingCount: number;
  lastReadingAt: string | null;
}

export interface AdminSensorSummary {
  id: string;
  name: string;
  unit: string;
  enabled: boolean;
  readingCount: number;
  lastReadingAt: string | null;
  activeAlarmCount: number;
}

export interface AdminUserDetail extends AdminUserSummary {
  sensors: AdminSensorSummary[];
}

export interface AdminUserUpdate {
  email?: string;
  plan?: "free" | "pro";
  password?: string;
}

async function send<T>(path: string, init: RequestInit, token?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new AdminApiError(
      response.status,
      `${init.method ?? "GET"} ${path} failed: ${response.status} ${body}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const adminLogin = (adminId: string, password: string) =>
  send<AdminLoginResult>("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ adminId, password }),
  });

export const fetchAdminOverview = (token: string) =>
  send<AdminOverview>("/api/admin/overview", { method: "GET" }, token);

export const fetchAdminUsers = (token: string) =>
  send<AdminUserSummary[]>("/api/admin/users", { method: "GET" }, token);

export const fetchAdminUser = (token: string, userId: string) =>
  send<AdminUserDetail>(`/api/admin/users/${userId}`, { method: "GET" }, token);

export const updateAdminUser = (token: string, userId: string, data: AdminUserUpdate) =>
  send<AdminUserDetail>(
    `/api/admin/users/${userId}`,
    { method: "PATCH", body: JSON.stringify(data) },
    token,
  );

export const deleteAdminUser = (token: string, userId: string) =>
  send<void>(`/api/admin/users/${userId}`, { method: "DELETE" }, token);
