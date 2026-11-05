import { afterEach, describe, expect, it } from "vitest";

import type { MeResponse } from "../types";
import { getStoredRefreshToken, useAuthStore } from "./useAuthStore";

// 認証の状態に入れる利用者の情報（この試験では中身は使わないので、最低限の値）
const me = { email: "user@example.com", workspaceName: "WS", plan: "free" } as unknown as MeResponse;

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useAuthStore.getState().clearAuth();
});

describe("利用者として閲覧中（impersonation）の認証", () => {
  it("閲覧を終えても、利用者本人のリフレッシュトークン（localStorage）は消さない", () => {
    localStorage.setItem("factoreye_rt", "owner-refresh-token");
    useAuthStore.getState().setImpersonated(
      { accessToken: "view-token", email: "user@example.com", workspaceName: "WS", expiresAt: Date.now() + 60_000 },
      me,
    );

    useAuthStore.getState().clearAuth();

    expect(getStoredRefreshToken()).toBe("owner-refresh-token");
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().impersonation).toBeNull();
  });

  it("閲覧中はリフレッシュトークンを保存しない", () => {
    useAuthStore.getState().setImpersonated(
      { accessToken: "view-token", email: "user@example.com", workspaceName: "WS", expiresAt: Date.now() + 60_000 },
      me,
    );

    expect(getStoredRefreshToken()).toBeNull();
    expect(useAuthStore.getState().accessToken).toBe("view-token");
  });

  it("通常のログアウトは、これまでどおりリフレッシュトークンを消す", () => {
    localStorage.setItem("factoreye_rt", "owner-refresh-token");
    useAuthStore.setState({ accessToken: "t", me: null, impersonation: null, isInitializing: false });

    useAuthStore.getState().clearAuth();

    expect(getStoredRefreshToken()).toBeNull();
  });
});
