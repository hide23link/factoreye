/**
 * Free Tier（SaaS の無料枠）の上限に達したときの表示用。
 *
 * バックエンドは上限を超えると HTTP 402 を返す（backend/app/api/sensors.py）。
 * 上限の数（10）は、バックエンドの値と必ず一致させること。
 */

// 無料枠でのセンサーの上限数（バックエンドの _FREE_TIER_SENSOR_LIMIT と同じ値）
export const FREE_TIER_SENSOR_LIMIT = 10;

// 上限に達したときに画面に出す案内文
export const FREE_TIER_LIMIT_MESSAGE =
  `無料プランのセンサー上限（${FREE_TIER_SENSOR_LIMIT}個）に達しました。` +
  "既存のセンサーを削除してから再度追加してください。";

/**
 * エラーが「無料枠の上限（402）」かどうかを判定する。
 * lib/api.ts のエラーメッセージは `<METHOD> <path> failed: <status> <body>` の形式なので、
 * "failed: 402" を含むかで見分ける。
 */
export const isFreeTierLimitError = (e: Error): boolean => e.message.includes("failed: 402");
