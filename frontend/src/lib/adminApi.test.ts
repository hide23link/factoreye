import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminApiError,
  adminErrorDetail,
  adminLogin,
  applyFailback,
  deleteAdminUser,
  fetchAdminUsers,
  previewFailback,
} from "./adminApi";

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

describe("書き戻し API", () => {
  it("試算は名前だけ、実行は名前と試算の件数を送る", async () => {
    const fetchFn = mockFetchOnce(200, { name: "n", applied: false, totalInserted: 0, tables: [], snapshot: null });
    await previewFailback("tok", "handoff-factoreye-20261028-103000.sql.gz");
    let [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/admin/failback/preview");
    expect(JSON.parse(init.body as string)).toEqual({ name: "handoff-factoreye-20261028-103000.sql.gz" });

    await applyFailback("tok", "handoff-factoreye-20261028-103000.sql.gz", 5);
    [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/api/admin/failback/apply");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "handoff-factoreye-20261028-103000.sql.gz",
      expectedInserted: 5,
    });
  });

  it("失敗の本文から、画面に出す文を取り出す", async () => {
    mockFetchOnce(409, { detail: "件数が変わりました" });
    const e1 = await previewFailback("tok", "n").catch((e: unknown) => e);
    expect(adminErrorDetail(e1, "既定")).toBe("件数が変わりました");

    mockFetchOnce(409, { detail: { code: "schema_mismatch", message: "版が違います" } });
    const e2 = await previewFailback("tok", "n").catch((e: unknown) => e);
    expect(adminErrorDetail(e2, "既定")).toBe("版が違います");

    mockFetchOnce(502, "<html>Bad Gateway</html>");
    const e3 = await previewFailback("tok", "n").catch((e: unknown) => e);
    expect(adminErrorDetail(e3, "既定")).toBe("既定");
    expect(adminErrorDetail(new Error("x"), "既定")).toBe("既定");
  });
});
