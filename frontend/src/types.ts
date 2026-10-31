/**
 * 画面とバックエンドの間でやり取りするデータの型。
 *
 * 注意: JSON の項目名は camelCase（例: ingestKey）。バックエンドの snake_case（ingest_key）とは、
 * バックエンドの CamelModel（app/schemas.py）が変換している。ここでは camelCase で書く。
 *
 * 【誰が使うか】lib/api.ts と、各画面・ウィジェット。バックエンドの schemas.py（API の入出力の形）と対応する。
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
  // 所属する取り込みの機器（self-hosted の機器ごとのキー）。SaaS・所属なしは null、古い API では項目なし
  deviceId?: string | null;
  deviceName?: string | null;
}

/** 測定値1件（時刻と値）。 */
export interface Reading {
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
export type MinMax = "min" | "max";
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
  thresholdBreached: MinMax;
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
  | "StatValue"
  // 半円のメーター（正常・軽故障・重故障の色の帯と針）
  | "Gauge"
  // 生産管理（1日の目標に対する進み具合）。稼働ステータス（ProductionStatus）とは別の種類
  | "ProductionPlan";

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
  // StatValueWidget・GaugeWidget用: 表示する小数桁数（未指定なら1桁）
  decimals?: number;
  // GaugeWidget用: メーターの目盛りの最小・最大（未指定なら、しきい値と現在値から自動で決める）
  gaugeMin?: number;
  gaugeMax?: number;
  // グラフ用: センサーごとの線の色（sensorIds と同じ順）。未指定なら既定の色
  colors?: string[];
  // グラフ用: センサーが1つのとき、軽故障・重故障のしきい値の線を重ねる
  showThresholds?: boolean;
  // グラフ用: このウィジェットだけの表示期間（時間）。未指定ならダッシュボード全体の期間に従う
  rangeHours?: number;
  // グラフ用の見た目。どれも未指定なら従来の見た目（読み方は lib/graph-config.ts の graphStyle）
  lineShape?: "smooth" | "linear" | "step";
  lineWidth?: number;
  // 面グラフの塗りの濃さ（0〜1）
  fillOpacity?: number;
  showPoints?: boolean;
  showGrid?: boolean;
  showTooltip?: boolean;
  legendPosition?: "bottom" | "right" | "off";
  // グラフ用: 区間（間引いたデータ）の値の出し方。未指定は平均
  aggregation?: "avg" | "max" | "min";
  // グラフ用: 自動で取り直す間隔（秒）。未指定は 30 秒
  refreshSeconds?: number;
  // グラフ用（センサー2つ以上）: 縦軸を実際の値にするか、センサーごとに 0〜100% にそろえるか。未指定は実際の値
  axisMode?: "shared" | "normalized";
  // グラフ用（センサー2つ以上の面・棒）: 積み上げ。未指定は積み上げない
  stack?: "none" | "normal" | "percent";
  // しきい値の表示（線・色の帯・両方・なし）。未指定なら showThresholds に従う（true は「線」）
  thresholdMode?: "off" | "line" | "area" | "both";
  // ProductionPlanWidget用: 勤務の開始・終了（時、0〜24）と、12:00 から始まる昼休みの長さ（分）
  workStartHour?: number;
  workEndHour?: number;
  breakMinutes?: number;
  // ProductionPlanWidget用: 表示項目の ON/OFF（未指定は表示する）
  showHourly?: boolean;
  showForecast?: boolean;
  showUptime?: boolean;
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
