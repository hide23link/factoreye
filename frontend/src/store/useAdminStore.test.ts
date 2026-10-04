import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "factoreye_admin_token";

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  sessionStorage.clear();
});

describe("useAdminStore", () => {
  it("トークンを sessionStorage に保存する", async () => {
    const { useAdminStore } = await import("./useAdminStore");
    useAdminStore.getState().setToken("tok-1");
    expect(sessionStorage.getItem(KEY)).toBe("tok-1");
    expect(useAdminStore.getState().token).toBe("tok-1");
  });

  it("再読み込み相当（モジュールの再評価）後もトークンを引き継ぐ", async () => {
    sessionStorage.setItem(KEY, "tok-kept");
    const { useAdminStore } = await import("./useAdminStore");
    expect(useAdminStore.getState().token).toBe("tok-kept");
  });

  it("clearToken で保存も消える", async () => {
    const { useAdminStore } = await import("./useAdminStore");
    useAdminStore.getState().setToken("tok-2");
    useAdminStore.getState().clearToken();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(useAdminStore.getState().token).toBeNull();
  });

  it("sessionStorage が使えなくてもメモリ上では動く", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { useAdminStore } = await import("./useAdminStore");
    expect(() => useAdminStore.getState().setToken("tok-3")).not.toThrow();
    expect(useAdminStore.getState().token).toBe("tok-3");
    spy.mockRestore();
  });
});
