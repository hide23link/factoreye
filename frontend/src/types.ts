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
  // 機器の系統（ライン）。付けていない機器・所属なし・SaaS は null、古い API では項目なし
  deviceLine?: string | null;
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

/** 配布版（OSS）の「API・取り込み」設定（設定ファイル .env の内容）。秘密の値（鍵）は含まれない。 */
export interface RuntimeSettings {
  // 取り込みキーが設定済みか（値そのものは返ってこない）
  ingestApiKeyConfigured: boolean;
  ingestAuth: "key" | "off";
  ingestAutoCreate: boolean;
  ingestAutoCreateMaxSensors: number;
  ingestDeviceTime: boolean;
  ingestRateLimit: string;
  ingestCacheSeconds: number;
  webhookAllowPrivateNetworks: boolean;
  frontendUrl: string;
  // 管理パスワードが設定済みか。未設定だと画面からは変更できない
  passwordConfigured: boolean;
  // 起動したあとに .env が書き換えられている（表示は反映前の値）
  fileChanged: boolean;
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
  | "ProductionPlan"
  // 達成ストリップ（一定の間隔ごとに、目標を満たしたかを緑・赤の帯で見せる。受信の確認と、生産の目標に使う）
  | "TargetStrip";

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
  // グラフ用（センサー2つ以上・実際の値）: センサーごとの縦軸の左右（センサーID → 左か右）。未指定は単位で決める
  axisSides?: Record<string, "left" | "right">;
  // グラフ用: 縦軸に出す単位の文字（左・右）。未指定・空欄なら、軸に載るセンサーの単位を自動で出す
  axisUnits?: { left?: string; right?: string };
  // 全ウィジェット共通: 枠の上に出すタイトル。未指定・空欄なら出さない
  title?: string;
  // グラフ用: 凡例に出す系列の名前（センサーID → 名前）。未指定はセンサーの名前
  seriesNames?: Record<string, string>;
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
  // TargetStrip（達成ストリップ）用。センサーは sensorIds に複数入れる
  // 1 マスの長さ（分、最短）。1・5・10 のいずれか。未指定は 1。表示期間は、グラフと同じ（ダッシュボードの時間範囲）
  // 表示期間が長くてマスが多すぎるときは、自動で広げる
  stripBucketMinutes?: number;
  // 1 時間あたりの目標。1 マスの目標 = これ × 間隔 ÷ 60。未指定は 60（受信の確認: 1 分に 1 回）
  stripHourlyTarget?: number;
  // 判定の方法。"count"（既定）= マスの合計が目標以上か（生産の目標）。"interval" = 受信の間隔が上限以内か（受信の確認）
  stripJudge?: "count" | "interval";
  // "interval" のとき、前回の受信からの最大の間隔（秒）。これを超えて受信が無い時間にかかるマスを赤にする。未指定は 90
  stripMaxGapSeconds?: number;
  // 1 分のマスで、前後のマスと 1 マス分まで融通するか（届く時刻の数秒のずれで赤にしない）。未指定は false（厳密）
  stripTolerant?: boolean;
  // 勤務時間（workStartHour・workEndHour・breakMinutes）の外を対象外にするか。未指定は false
  stripWorkOnly?: boolean;
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

/** 取り込みの機器（OSS 版の機器ごとのキー）。キーそのものは持たない（作成時の応答でだけ返る）。 */
export interface Device {
  id: string;
  name: string;
  line: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** 所属するセンサーの最新の測定値の時刻。まだ受信がなければ null */
  lastReceivedAt: string | null;
  /** 所属するセンサーの Ingest Key */
  sensors: string[];
}

/** 機器を作った直後の応答。key は、このときだけ読める。 */
export interface DeviceCreated extends Device {
  key: string;
}
