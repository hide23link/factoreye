import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeAlarm,
  createSensor,
  deleteSensor,
  fetchSensorReadingsAggregate,
  fetchSensors,
  logout,
} from "./api";
import { ApiError } from "./errors";
import { useAuthStore } from "../store/useAuthStore";
import type { MeResponse } from "../types";

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("GETは成功時にレスポンスをJSONとして返す", async () => {
    mockFetchOnce(200, [{ id: "s1", name: "sensor-1" }]);
    const sensors = await fetchSensors();
    expect(sensors).toEqual([{ id: "s1", name: "sensor-1" }]);
  });

  it("失敗レスポンスはステータスコードと本文を含むエラーを投げる", async () => {
    mockFetchOnce(409, "duplicate name");
    await expect(fetchSensors()).rejects.toThrow(/409/);
  });

  it("204 No Contentはundefinedを返す（DELETE系）", async () => {
    mockFetchOnce(204, null);
    const result = await deleteSensor("s1");
    expect(result).toBeUndefined();
  });

  it("POSTはボディをJSONエンコードして送信する", async () => {
    mockFetchOnce(201, { id: "s2", name: "new sensor" });
    await createSensor({ name: "new sensor", ingestKey: "key-1", unit: "°C" });

    const fetchMock = vi.mocked(fetch);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "new sensor",
      ingestKey: "key-1",
      unit: "°C",
    });
  });

  it("PATCHは確認者情報を含めてackエンドポイントを呼ぶ", async () => {
    mockFetchOnce(200, { id: "a1", status: "acknowledged" });
    await acknowledgeAlarm("a1", "admin");

    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/alarms\/a1\/ack$/);
    expect(init?.method).toBe("PATCH");
  });

  it("readings/aggregateはfromのみ指定時はtoを付けずに呼ぶ", async () => {
    mockFetchOnce(200, { sum: 12, count: 3 });
    const result = await fetchSensorReadingsAggregate("s1", "2024-01-01T00:00:00.000Z");

    expect(result).toEqual({ sum: 12, count: 3 });
    const fetchMock = vi.mocked(fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/sensors/s1/readings/aggregate?from=");
    expect(url).not.toContain("to=");
  });

  it("readings/aggregateはtoを指定するとクエリに含める", async () => {
    mockFetchOnce(200, { sum: 0, count: 0 });
    await fetchSensorReadingsAggregate(
      "s1",
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T01:00:00.000Z",
    );

    const fetchMock = vi.mocked(fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("to=");
  });
});

describe("ログアウトと認証の更新", () => {
  afterEach(() => {
    localStorage.clear();
    useAuthStore.getState().clearAuth();
  });

  const me = { email: "u@example.com", workspaceName: "WS", plan: "free" } as unknown as MeResponse;

  it("logout はリフレッシュトークンをサーバーへ送って失効させ、端末のログインも消す", async () => {
    useAuthStore.getState().setAuth("access-1", "refresh-1", me);
    mockFetchOnce(204, null);

    await logout();

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("/api/auth/logout");
    expect(JSON.parse(init?.body as string)).toEqual({ refreshToken: "refresh-1" });
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(localStorage.getItem("factoreye_rt")).toBeNull();
  });

  it("logout はサーバーへの通知が失敗しても、端末のログアウトを完了させる", async () => {
    useAuthStore.getState().setAuth("access-1", "refresh-1", me);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(logout()).resolves.toBeUndefined();

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(localStorage.getItem("factoreye_rt")).toBeNull();
  });

  it("失敗の応答は、状態コードを持つ ApiError になる", async () => {
    mockFetchOnce(409, "duplicate");
    const err = await fetchSensors().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
  });

  it("401 が同時に複数起きても、再発行は 1 回だけで、全員が新しいトークンで再試行して成功する", async () => {
    useAuthStore.getState().setAuth("old-access", "refresh-1", me);
    let refreshCalls = 0;
    const okJson = (body: unknown) => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/auth/refresh")) {
          refreshCalls += 1;
          await new Promise((r) => setTimeout(r, 20));
          return okJson({ accessToken: "new-access", refreshToken: "refresh-2" });
        }
        const auth = (init?.headers as Record<string, string>).Authorization;
        if (auth === "Bearer old-access") {
          return { ok: false, status: 401, text: () => Promise.resolve("expired") };
        }
        return okJson([{ id: "s1" }]);
      }),
    );

    const results = await Promise.all([fetchSensors(), fetchSensors(), fetchSensors()]);

    expect(results).toEqual([[{ id: "s1" }], [{ id: "s1" }], [{ id: "s1" }]]);
    expect(refreshCalls).toBe(1);
    expect(useAuthStore.getState().accessToken).toBe("new-access");
  });

  it("再発行に失敗したとき、待っていた全員が「Session expired」になる", async () => {
    useAuthStore.getState().setAuth("old-access", "refresh-1", me);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/auth/refresh")) {
          return { ok: false, status: 401, text: () => Promise.resolve("revoked") };
        }
        return { ok: false, status: 401, text: () => Promise.resolve("expired") };
      }),
    );

    const results = await Promise.allSettled([fetchSensors(), fetchSensors()]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
