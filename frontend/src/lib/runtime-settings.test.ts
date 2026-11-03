import { describe, expect, it } from "vitest";

import type { RuntimeSettings } from "../types";
import { buildChanges, generateIngestKey, toForm } from "./runtime-settings";

const current: RuntimeSettings = {
  ingestApiKeyConfigured: true,
  ingestAuth: "key",
  ingestAutoCreate: false,
  ingestAutoCreateMaxSensors: 100,
  ingestDeviceTime: false,
  ingestRateLimit: "100/minute",
  ingestCacheSeconds: 5,
  webhookAllowPrivateNetworks: false,
  frontendUrl: "http://192.168.0.20:3001",
  passwordConfigured: true,
  fileChanged: false,
};

describe("buildChanges", () => {
  it("何も触っていなければ、空（何も送らない）", () => {
    expect(buildChanges(current, toForm(current), null)).toEqual({});
  });

  it("変えた項目だけを、.env の項目名と文字列の値で返す", () => {
    const form = { ...toForm(current), ingestAuth: "off" as const, ingestAutoCreate: true, ingestRateLimit: " 50/minute " };
    expect(buildChanges(current, form, null)).toEqual({
      INGEST_AUTH: "off",
      INGEST_AUTO_CREATE: "true",
      INGEST_RATE_LIMIT: "50/minute",
    });
  });

  it("数値は、書き方が違っても値が同じなら変更とみなさない（5 と 5.0）", () => {
    const form = { ...toForm(current), ingestCacheSeconds: "5.0" };
    expect(buildChanges(current, form, null)).toEqual({});
  });

  it("新しく作ったキーがあるときだけ、取り込みキーを含める", () => {
    expect(buildChanges(current, toForm(current), "k".repeat(48))).toEqual({ INGEST_API_KEY: "k".repeat(48) });
  });
});

describe("generateIngestKey", () => {
  it("48 文字の 16 進数で、毎回違う", () => {
    const first = generateIngestKey();
    expect(first).toMatch(/^[0-9a-f]{48}$/);
    expect(generateIngestKey()).not.toBe(first);
  });
});
