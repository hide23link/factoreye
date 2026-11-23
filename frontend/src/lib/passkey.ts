/**
 * パスキー（WebAuthn）を、ブラウザ（navigator.credentials）で呼ぶ小さな包み。
 *
 * サーバーが返すオプションは JSON（鍵や乱数は base64url の文字列）。ブラウザの API はバイト列
 * （ArrayBuffer）を要るので、ここで相互に変換する。端末の応答も、サーバーへ送れる JSON にする。
 * 画面（LoginPage など）は、この関数だけを呼ぶ。テストでは、このモジュールを差し替える。
 *
 * 【誰が使うか】components/auth/（登録・ログイン）、components/settings/PasskeysSettingsPanel.tsx（端末の追加）。
 */

/** 利用者が、端末の確認画面（指紋・顔・PIN）をやめた、または時間切れ。エラーにせず、静かに戻す。 */
export class PasskeyCancelledError extends Error {
  constructor() {
    super("passkey operation was cancelled");
    this.name = "PasskeyCancelledError";
  }
}

/** この端末・ブラウザが、パスキーに対応しているか。 */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function"
  );
}

/** base64url の文字列を、バイト列にする。 */
export function base64UrlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** バイト列を、base64url の文字列にする。 */
export function bufferToBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Json = Record<string, unknown>;

/** 認証情報の除外・許可の一覧（id が base64url）を、ブラウザの形（id がバイト列）にする。 */
function descriptors(list: unknown): PublicKeyCredentialDescriptor[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const entry = item as Json;
    return {
      type: "public-key" as const,
      id: base64UrlToBuffer(String(entry.id)),
      transports: Array.isArray(entry.transports)
        ? (entry.transports as AuthenticatorTransport[])
        : undefined,
    };
  });
}

/** サーバーの登録オプション（JSON）を、navigator.credentials.create に渡せる形にする。 */
export function toCreationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const user = json.user as Json;
  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64UrlToBuffer(String(json.challenge)),
    user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: base64UrlToBuffer(String(user.id)) },
    excludeCredentials: descriptors(json.excludeCredentials),
  };
}

/** サーバーのログインオプション（JSON）を、navigator.credentials.get に渡せる形にする。 */
export function toRequestOptions(json: Json): PublicKeyCredentialRequestOptions {
  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64UrlToBuffer(String(json.challenge)),
    allowCredentials: descriptors(json.allowCredentials),
  };
}

/** 端末の操作の失敗のうち、利用者が自分でやめた・時間切れ（NotAllowedError）を見分ける。 */
function asCancel(err: unknown): unknown {
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) {
    return new PasskeyCancelledError();
  }
  return err;
}

/** 登録: 端末にパスキーを作らせ、サーバーへ送れる JSON にして返す。 */
export async function createPasskey(options: Json): Promise<Json> {
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({ publicKey: toCreationOptions(options) });
  } catch (err) {
    throw asCancel(err);
  }
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyCancelledError();
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

/** ログイン: 端末に署名させ、サーバーへ送れる JSON にして返す。アドレスは聞かない（端末の選択画面）。 */
export async function getPasskey(options: Json): Promise<Json> {
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({ publicKey: toRequestOptions(options) });
  } catch (err) {
    throw asCancel(err);
  }
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyCancelledError();
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

/** この端末の名前の初期値（例: Mac の Chrome）。利用者があとから変えられる。 */
export function defaultDeviceName(): string {
  if (typeof navigator === "undefined") return "この端末";
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "この端末";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return browser ? `${os} の ${browser}` : os;
}
