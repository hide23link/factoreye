// 管理者API（/api/admin）のクライアント。通常ユーザーの lib/api.ts とは別管理。
// トークンは呼び出し側（管理者ストア）が持ち、ここでは保存しない。
// 【誰が使うか】管理者画面（AdminLoginPage、AdminUsersPage、AdminUserModal、IngestLimitCard、FailbackCard）。
import { API_BASE_URL } from "./api";

/** 管理者 API の失敗（HTTP の状態コードを持つ）。画面は status で、失効（401）などを判断する。 */
export class AdminApiError extends Error {
  readonly status: number;
  /** サーバーが返した本文（JSON の文字列）。画面に出す文を取り出すのに使う（adminErrorDetail）。 */
  readonly body: string;

  constructor(status: number, message: string, body = "") {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.body = body;
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

/** 利用者として閲覧するためのトークン（短い期限・リフレッシュなし）。 */
export interface ImpersonationResult {
  accessToken: string;
  email: string;
  workspaceName: string;
  /** 期限（ISO の時刻文字列） */
  expiresAt: string;
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
      body,
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

/** 利用者として閲覧するためのトークンを発行する（開始は記録される）。 */
export const impersonateAdminUser = (token: string, userId: string) =>
  send<ImpersonationResult>(`/api/admin/users/${userId}/impersonate`, { method: "POST" }, token);

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

/**
 * 失敗の本文から、画面に出す文を取り出す（FastAPI の { detail: "文" } か { detail: { message: "文" } }）。
 * 取り出せなければ fallback を返す（本文はそのまま出さない）。
 */
export function adminErrorDetail(error: unknown, fallback: string): string {
  if (!(error instanceof AdminApiError)) return fallback;
  try {
    const detail = (JSON.parse(error.body) as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail) return detail;
    if (detail && typeof detail === "object") {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  } catch {
    // JSON ではない本文（プロキシのエラー画面など）は、fallback を使う
  }
  return fallback;
}

// ── 書き戻し（控え＝AWS が稼いだデータを本番に足す） ─────────────────────────

/** 引き継ぎ（控えが R2 に置いた縮小ダンプ）の1件。種類・起点などは、最新の1件だけに付く。 */
export interface FailbackHandoff {
  name: string;
  size: number;
  modified: string;
  kind: string | null;
  watermark: string | null;
  alembic: string | null;
  instance: string | null;
  region: string | null;
  createdAt: string | null;
}

export interface FailbackHandoffList {
  source: string;
  items: FailbackHandoff[];
}

/** 表ごとの件数: 引き継ぎの対象／本番に足す（足した）／本番に既にある。 */
export interface FailbackTable {
  table: string;
  source: number;
  inserted: number;
  existing: number;
  note: string | null;
  closed: number;
}

/** 試算または実行の結果。実行のときは applied=true で、直前の本番の控え（snapshot）の名前が付く。 */
export interface FailbackResult {
  name: string;
  applied: boolean;
  totalInserted: number;
  tables: FailbackTable[];
  snapshot: string | null;
}

export const fetchFailbackHandoffs = (token: string) =>
  send<FailbackHandoffList>("/api/admin/failback/handoffs", { method: "GET" }, token);

/** 試算（本番には何も書かない）。 */
export const previewFailback = (token: string, name: string) =>
  send<FailbackResult>(
    "/api/admin/failback/preview",
    { method: "POST", body: JSON.stringify({ name }) },
    token,
  );

/** 実行。expectedInserted は試算で確認した合計で、違えばサーバーが実行しない（409）。 */
export const applyFailback = (token: string, name: string, expectedInserted: number) =>
  send<FailbackResult>(
    "/api/admin/failback/apply",
    { method: "POST", body: JSON.stringify({ name, expectedInserted }) },
    token,
  );
