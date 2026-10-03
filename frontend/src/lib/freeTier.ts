// Free Tier の上限（センサー10個）に達したときの表示用。
// バックエンドは上限超過時に HTTP 402 を返す（backend/app/api/sensors.py）。

export const FREE_TIER_SENSOR_LIMIT = 10;

export const FREE_TIER_LIMIT_MESSAGE =
  `無料プランのセンサー上限（${FREE_TIER_SENSOR_LIMIT}個）に達しました。` +
  "既存のセンサーを削除してから再度追加してください。";

// lib/api.ts のエラーメッセージは `<METHOD> <path> failed: <status> <body>` の形式
export const isFreeTierLimitError = (e: Error): boolean => e.message.includes("failed: 402");
