import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PasskeyCancelledError,
  base64UrlToBuffer,
  bufferToBase64Url,
  createPasskey,
  defaultDeviceName,
  getPasskey,
  isPasskeySupported,
  toCreationOptions,
  toRequestOptions,
} from "./passkey";

// jsdom には WebAuthn が無いので、ブラウザの代わりを置く
class FakePublicKeyCredential {
  id = "AQID";
  type = "public-key";
  rawId = new Uint8Array([1, 2, 3]).buffer;
  constructor(public response: unknown) {}
  getClientExtensionResults() {
    return {};
  }
}

function setCredentials(impl: { create?: unknown; get?: unknown } | undefined) {
  Object.defineProperty(navigator, "credentials", { value: impl, configurable: true });
}

beforeEach(() => {
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCredentials(undefined);
});

describe("base64url", () => {
  it("往復しても同じ（+ / = を使わない形）", () => {
    const bytes = new Uint8Array([251, 255, 254, 0, 1, 2, 62, 63]);
    const text = bufferToBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(new Uint8Array(base64UrlToBuffer(text))).toEqual(bytes);
  });

  it("ArrayBuffer も ArrayBufferView（部分）も変換できる", () => {
    const whole = new Uint8Array([1, 2, 3, 4]);
    expect(bufferToBase64Url(whole.buffer)).toBe(bufferToBase64Url(whole));
    expect(bufferToBase64Url(whole.subarray(1, 3))).toBe(bufferToBase64Url(new Uint8Array([2, 3])));
  });
});

describe("オプションの変換", () => {
  it("登録: challenge・user.id・excludeCredentials の id をバイト列にする", () => {
    const options = toCreationOptions({
      challenge: "AQID",
      rp: { id: "example.com", name: "FactorEye" },
      user: { id: "BAUG", name: "a@example.com", displayName: "A" },
      excludeCredentials: [{ type: "public-key", id: "Bwg" }],
    });
    expect(new Uint8Array(options.challenge as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(options.user.id as ArrayBuffer)).toEqual(new Uint8Array([4, 5, 6]));
    expect(options.user.name).toBe("a@example.com");
    expect(new Uint8Array(options.excludeCredentials![0].id as ArrayBuffer)).toEqual(new Uint8Array([7, 8]));
  });

  it("ログイン: allowCredentials が無ければ空（端末の選択画面でアカウントを選ぶ）", () => {
    const options = toRequestOptions({ challenge: "AQID", rpId: "example.com", userVerification: "required" });
    expect(new Uint8Array(options.challenge as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(options.allowCredentials).toEqual([]);
    expect(options.userVerification).toBe("required");
  });
});

describe("isPasskeySupported", () => {
  it("PublicKeyCredential と navigator.credentials があれば true、無ければ false", () => {
    setCredentials({ create: vi.fn(), get: vi.fn() });
    expect(isPasskeySupported()).toBe(true);
    setCredentials(undefined);
    expect(isPasskeySupported()).toBe(false);
    vi.stubGlobal("PublicKeyCredential", undefined);
    setCredentials({ create: vi.fn(), get: vi.fn() });
    expect(isPasskeySupported()).toBe(false);
  });
});

describe("createPasskey", () => {
  const options = {
    challenge: "AQID",
    rp: { id: "example.com", name: "FactorEye" },
    user: { id: "BAUG", name: "a@example.com", displayName: "A" },
  };

  it("端末の応答を、サーバーへ送れる JSON（base64url）にする", async () => {
    const response = {
      clientDataJSON: new Uint8Array([1]).buffer,
      attestationObject: new Uint8Array([2]).buffer,
      getTransports: () => ["internal"],
    };
    const create = vi.fn().mockResolvedValue(new FakePublicKeyCredential(response));
    setCredentials({ create, get: vi.fn() });

    const json = await createPasskey(options);

    expect(create).toHaveBeenCalledOnce();
    expect(json).toMatchObject({
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      response: { clientDataJSON: "AQ", attestationObject: "Ag", transports: ["internal"] },
    });
  });

  it("利用者が端末の画面をやめた（NotAllowedError）ときは、PasskeyCancelledError にする", async () => {
    setCredentials({
      create: vi.fn().mockRejectedValue(new DOMException("cancelled", "NotAllowedError")),
      get: vi.fn(),
    });
    await expect(createPasskey(options)).rejects.toBeInstanceOf(PasskeyCancelledError);
  });

  it("ほかの失敗は、そのまま投げる", async () => {
    const boom = new Error("boom");
    setCredentials({ create: vi.fn().mockRejectedValue(boom), get: vi.fn() });
    await expect(createPasskey(options)).rejects.toBe(boom);
  });
});

describe("getPasskey", () => {
  it("署名の応答を JSON にする。userHandle が無ければ null", async () => {
    const response = {
      clientDataJSON: new Uint8Array([1]).buffer,
      authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
      userHandle: null,
    };
    setCredentials({ create: vi.fn(), get: vi.fn().mockResolvedValue(new FakePublicKeyCredential(response)) });

    const json = await getPasskey({ challenge: "AQID", rpId: "example.com" });

    expect(json).toMatchObject({
      rawId: "AQID",
      response: { authenticatorData: "Ag", signature: "Aw", userHandle: null },
    });
  });

  it("画面をやめたときは PasskeyCancelledError", async () => {
    setCredentials({
      create: vi.fn(),
      get: vi.fn().mockRejectedValue(new DOMException("timeout", "NotAllowedError")),
    });
    await expect(getPasskey({ challenge: "AQID" })).rejects.toBeInstanceOf(PasskeyCancelledError);
  });
});

describe("defaultDeviceName", () => {
  it("OS とブラウザから、端末の名前の初期値を作る", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
    );
    expect(defaultDeviceName()).toBe("Mac の Chrome");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1");
    expect(defaultDeviceName()).toBe("iPhone の Safari");
  });
});
