import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApiError, adminLogin, deleteAdminUser, fetchAdminUsers } from "./adminApi";

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin api client", () => {
  it("ログインはadminId/passwordを送り、トークンを返す", async () => {
    const fetchFn = mockFetchOnce(200, { accessToken: "tok", tokenType: "bearer" });
    const result = await adminLogin("admin", "pw-123456");

    expect(result.accessToken).toBe("tok");
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/admin/login");
    expect(JSON.parse(init.body as string)).toEqual({ adminId: "admin", password: "pw-123456" });
    // ログイン時は Authorization を付けない
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("管理者APIはBearerトークンを付ける", async () => {
    const fetchFn = mockFetchOnce(200, []);
    await fetchAdminUsers("admin-token");

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer admin-token");
  });

  it("失敗時はステータス付きの AdminApiError を投げる", async () => {
    mockFetchOnce(401, { detail: "invalid id or password" });
    await expect(adminLogin("admin", "wrong")).rejects.toMatchObject({
      status: 401,
    });
    await expect(adminLogin("admin", "wrong")).rejects.toBeInstanceOf(AdminApiError);
  });

  it("204 は空を返す（削除）", async () => {
    mockFetchOnce(204, undefined);
    await expect(deleteAdminUser("tok", "u1")).resolves.toBeUndefined();
  });
});
