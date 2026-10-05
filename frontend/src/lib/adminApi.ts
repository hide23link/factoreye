// 管理者API（/api/admin）のクライアント。通常ユーザーの lib/api.ts とは別管理。
// トークンは呼び出し側（管理者ストア）が持ち、ここでは保存しない。
import { API_BASE_URL } from "./api";

/** 管理者 API の失敗（HTTP の状態コードを持つ）。画面は status で、失効（401）などを判断する。 */
export class AdminApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

/** 管理者ログインの応答（トークン）。 */
export interface AdminLoginResult {
  accessToken: string;
  tokenType: string;
}

/** 全体の件数と DB の使用量（管理者の概要）。 */
export interface AdminOverview {
  userCount: number;
  workspaceCount: number;
  sensorCount: number;
  readingCount: number;
  databaseSizeBytes: number;
}

/** 利用者の一覧1行分（ワークスペースと集計）。 */
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

/** 利用者の詳細に出す、センサー1件分の集計。 */
export interface AdminSensorSummary {
  id: string;
  name: string;
  unit: string;
  enabled: boolean;
  readingCount: number;
  lastReadingAt: string | null;
  activeAlarmCount: number;
}

/** 利用者の詳細（一覧の項目に、センサーごとの状況を加える）。 */
export interface AdminUserDetail extends AdminUserSummary {
  sensors: AdminSensorSummary[];
}

/** 利用者の修正の入力。送る項目だけ変わる（省略は変えない）。password を送ると、ログインは全て無効になる。 */
export interface AdminUserUpdate {
  email?: string;
  plan?: "free" | "pro";
  password?: string;
}

/**
 * 管理者 API を呼ぶ共通の関数。token があれば Authorization に付ける。
 * 失敗（HTTP エラー）は AdminApiError にする。204（内容なし）は undefined を返す。
 */
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

// 管理者ログイン（トークンを取る）。トークンはまだ無いので、Authorization は付けない
export const adminLogin = (adminId: string, password: string) =>
  send<AdminLoginResult>("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ adminId, password }),
  });

// 以下は、すべて管理者トークンが必要な API
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

export interface IngestLimitStatus {
  // 既定の制限（例: 100/minute）と、環境変数で解除されているか（変更できない）
  defaultLimit: string;
  envOff: boolean;
  // 期限付き解除の状態。解除中でなければ bypassUntil は null
  bypassed: boolean;
  bypassUntil: string | null;
  setBy: string | null;
  setAt: string | null;
}

export const fetchIngestLimit = (token: string) =>
  send<IngestLimitStatus>("/api/admin/ingest-limit", { method: "GET" }, token);

export const setIngestLimit = (token: string, enabled: boolean, minutes = 60) =>
  send<IngestLimitStatus>(
    "/api/admin/ingest-limit",
    { method: "PUT", body: JSON.stringify({ enabled, minutes }) },
    token,
  );
