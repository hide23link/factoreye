import { afterEach, describe, expect, it } from "vitest";

import { clearImpersonation, readImpersonation, saveImpersonation } from "./impersonation";

const NOW = Date.parse("2026-10-05T04:00:00.000Z");
const info = {
  accessToken: "tok",
  email: "user@example.com",
  workspaceName: "WS",
  expiresAt: NOW + 15 * 60 * 1000,
};

afterEach(() => {
  sessionStorage.clear();
});

describe("閲覧の情報（impersonation）", () => {
  it("保存したものを、期限内なら読める", () => {
    saveImpersonation(info);
    expect(readImpersonation(NOW)).toEqual(info);
  });

  it("期限が過ぎたものは読めず、保存も消える", () => {
    saveImpersonation(info);
    expect(readImpersonation(info.expiresAt)).toBeNull();
    expect(sessionStorage.getItem("factoreye_impersonation")).toBeNull();
  });

  it("壊れた値は読めない", () => {
    sessionStorage.setItem("factoreye_impersonation", "{not json");
    expect(readImpersonation(NOW)).toBeNull();
  });

  it("clear で消える", () => {
    saveImpersonation(info);
    clearImpersonation();
    expect(readImpersonation(NOW)).toBeNull();
  });
});
