/**
 * Free Tier（SaaS の無料枠）の上限に達したときの表示用。
 *
 * バックエンドは上限を超えると HTTP 402 を返す（backend/app/api/sensors.py）。
 * 上限の数（10）は、バックエンドの値と必ず一致させること。
 *
 * 【誰が使うか】SensorSettingsPanel、SetupWizard、管理者画面（AdminUsersPage、AdminUserModal）。
 */

import { errorStatus } from "./errors";

// 無料枠でのセンサーの上限数（バックエンドの _FREE_TIER_SENSOR_LIMIT と同じ値）
export const FREE_TIER_SENSOR_LIMIT = 10;

// 上限に達したときに画面に出す案内文
export const FREE_TIER_LIMIT_MESSAGE =
  `無料プランのセンサー上限（${FREE_TIER_SENSOR_LIMIT}個）に達しました。` +
  "既存のセンサーを削除してから再度追加してください。";

/**
 * エラーが「無料枠の上限（402）」かどうかを判定する。
 * 状態コード（ApiError.status）で見分ける。状態コードを持たない例外は、従来どおりメッセージの
 * `<METHOD> <path> failed: <status> <body>` の形式で見分ける（テストや古い呼び出しのため）。
 */
export const isFreeTierLimitError = (e: Error): boolean => {
  const status = errorStatus(e);
  return status !== null ? status === 402 : e.message.includes("failed: 402");
};
