/**
 * 画面とバックエンドの間でやり取りするデータの型。
 *
 * 注意: JSON の項目名は camelCase（例: ingestKey）。バックエンドの snake_case（ingest_key）とは、
 * バックエンドの CamelModel（app/schemas.py）が変換している。ここでは camelCase で書く。
 */

// ---- Auth (Phase 0.5) ----

/** ログイン・再発行の応答（SaaS 版）。 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
}

/** ログイン中の利用者と、そのワークスペース（SaaS 版）。 */
export interface MeResponse {
  userId: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  plan: "free" | "pro";
}

// ---- Migration (SaaS → OSS) ----

/** 移行機能の状態。mode で SaaS か OSS か、canExport / canImport で使える操作を判断する。 */
export interface MigrationStatus {
  mode: "multi_tenant" | "self_hosted";
  // SaaS（multi_tenant）だけ書き出せる。self-hosted だけ取り込める
  canExport: boolean;
  canImport: boolean;
}

/** 取り込みの結果（確認のみの dryRun のときは、取り込めるはずの件数）。 */
export interface MigrationImportResult {
  dryRun: boolean;
  // テーブル名 → 件数（dry-run のときは「取り込めるはずの件数」）
  counts: Record<string, number>;
}

// ---- Domain ----

/** センサー（測定の元になる機器1つ分）。閾値の4項目と不感帯を持つ。 */
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

/** 測定値1件（時刻と値）。 */
export interface Reading {
  id: number;
  sensorId: string;
  value: number;
  recordedAt: string;
}

/** 期間の集計（合計と件数）。「本日累計」などに使う。 */
export interface ReadingAggregate {
  sum: number;
  count: number;
}

// アラームの状態（発生中・確認済み・解除済み）
export type AlarmStatus = "active" | "acknowledged" | "resolved";
// どちら側のしきい値を超えたか（下限・上限）
export type ThresholdBreached = "min" | "max";
// 重要度（軽故障・重故障）。画面の表示や、通知の送り先に使う
export type AlarmSeverity = "warning" | "critical";

/** アラーム1件（発生から解除までの記録）。 */
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

/** 通知設定（Discord の送信先、有効/無効、重故障の再通知）。 */
export interface NotificationSettings {
  discordWebhookUrlCritical: string;
  discordWebhookUrlWarning: string;
  enabled: boolean;
  // 重故障のみ: 未解決のまま一定時間（分）経過したら同じアラームを再通知する
  criticalRepeatEnabled: boolean;
  criticalRepeatIntervalMinutes: number;
}

// Zapier/Make/n8n等のノーコード自動化サービスへ繋ぐための汎用Webhook（Phase 1）
// Webhook で送るイベントの種類（測定値の受信・アラーム発生）
export type WebhookEventType = "reading.received" | "alarm.triggered";

/** Webhook の購読1件（イベントの種類と、送信先の URL）。 */
export interface WebhookSubscription {
  id: string;
  eventType: WebhookEventType;
  url: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type WidgetType =
  | "SensorGraph"
  | "ProductionStatus"
  | "AlarmAlert"
  | "MultiSensorComparison"
  | "StatValue";

/** ウィジェットの表示設定（色・Y 軸の範囲など）。 */
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

/** ダッシュボードに置くウィジェット1つ分（種類・位置・サイズ・設定）。 */
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

/** ダッシュボード1つ分（一覧で使う。ウィジェットは含まない）。 */
export interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  layoutConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** ダッシュボードの詳細（ウィジェットの一覧を含む）。 */
export interface DashboardDetail extends Dashboard {
  widgets: Widget[];
}
