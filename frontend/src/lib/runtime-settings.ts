/**
 * 「API・取り込み」設定（RuntimeSettingsPanel）の、フォームの値と .env の値の変換。
 *
 * - toForm: サーバーの設定（RuntimeSettings）を、入力欄の値（文字列・真偽）にする
 * - buildChanges: 入力欄の値と、今の設定を比べて、変わった項目だけを .env の項目名で返す
 * - generateIngestKey: 新しい取り込みキー（乱数）を作る
 *
 * 【誰が使うか】components/settings/RuntimeSettingsPanel.tsx。
 * 変更のあった項目だけを送るので、触っていない項目（例: 取り込みキー）が書き換わることはない。
 */
import type { RuntimeSettings } from "../types";

/** 入力欄の値。数値の欄も、入力途中の状態を持てるよう文字列で持つ。 */
export interface RuntimeForm {
  ingestAuth: "key" | "off";
  ingestAutoCreate: boolean;
  ingestAutoCreateMaxSensors: string;
  ingestDeviceTime: boolean;
  ingestRateLimit: string;
  ingestCacheSeconds: string;
  webhookAllowPrivateNetworks: boolean;
  frontendUrl: string;
}

export function toForm(settings: RuntimeSettings): RuntimeForm {
  return {
    ingestAuth: settings.ingestAuth,
    ingestAutoCreate: settings.ingestAutoCreate,
    ingestAutoCreateMaxSensors: String(settings.ingestAutoCreateMaxSensors),
    ingestDeviceTime: settings.ingestDeviceTime,
    ingestRateLimit: settings.ingestRateLimit,
    ingestCacheSeconds: String(settings.ingestCacheSeconds),
    webhookAllowPrivateNetworks: settings.webhookAllowPrivateNetworks,
    frontendUrl: settings.frontendUrl,
  };
}

const bool = (value: boolean) => (value ? "true" : "false");

/**
 * 変わった項目だけを、.env の項目名と値（文字列）で返す。何も変わっていなければ空。
 * newIngestKey は、「新しく作る」で作ったキー（作っていなければ null）。
 */
export function buildChanges(
  current: RuntimeSettings,
  form: RuntimeForm,
  newIngestKey: string | null,
): Record<string, string> {
  const changes: Record<string, string> = {};
  if (newIngestKey) changes.INGEST_API_KEY = newIngestKey;
  if (form.ingestAuth !== current.ingestAuth) changes.INGEST_AUTH = form.ingestAuth;
  if (form.ingestAutoCreate !== current.ingestAutoCreate) changes.INGEST_AUTO_CREATE = bool(form.ingestAutoCreate);
  if (Number(form.ingestAutoCreateMaxSensors) !== current.ingestAutoCreateMaxSensors) {
    changes.INGEST_AUTO_CREATE_MAX_SENSORS = form.ingestAutoCreateMaxSensors.trim();
  }
  if (form.ingestDeviceTime !== current.ingestDeviceTime) changes.INGEST_DEVICE_TIME = bool(form.ingestDeviceTime);
  if (form.ingestRateLimit.trim() !== current.ingestRateLimit) changes.INGEST_RATE_LIMIT = form.ingestRateLimit.trim();
  if (Number(form.ingestCacheSeconds) !== current.ingestCacheSeconds) {
    changes.INGEST_CACHE_SECONDS = form.ingestCacheSeconds.trim();
  }
  if (form.webhookAllowPrivateNetworks !== current.webhookAllowPrivateNetworks) {
    changes.WEBHOOK_ALLOW_PRIVATE_NETWORKS = bool(form.webhookAllowPrivateNetworks);
  }
  if (form.frontendUrl.trim() !== current.frontendUrl) changes.FRONTEND_URL = form.frontendUrl.trim();
  return changes;
}

/** 新しい取り込みキー。48 文字の 16 進数（ブラウザの乱数。バックエンドの形式 [A-Za-z0-9._-]{16,128} に合う）。 */
export function generateIngestKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
