import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeAlarm,
  createSensor,
  deleteSensor,
  fetchDashboard,
  fetchSensorReadingsAggregate,
  fetchSensorReadingsDownsampled,
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

  it("ダッシュボードの ID は、パスに入れるときにエンコードする（リンクの URL から来る値で、別の API に届かないように）", async () => {
    mockFetchOnce(200, {});
    await fetchDashboard("../sensors?x#y");

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain("/api/dashboards/..%2Fsensors%3Fx%23y");
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

describe("グラフ用の間引きの取得（まとめ API）", () => {
  it("短い間の複数センサーの取得は、POST 1 回になり、センサーごとの結果が返る", async () => {
    vi.useFakeTimers();
    const data = (min: number) => ({ bucketSeconds: 60, buckets: [{ start: "2026-11-21T00:00:00Z", min, avg: min, max: min, count: 1 }] });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          results: [
            { sensorId: "s1", status: 200, data: data(1) },
            { sensorId: "s2", status: 404, data: null, detail: "sensor not found" },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = fetchSensorReadingsDownsampled("s1", "2026-11-14T00:00:00.000Z", "2026-11-21T00:00:00.000Z", 500);
    const second = fetchSensorReadingsDownsampled("s2", "2026-11-14T00:00:00.000Z", "2026-11-21T00:00:00.000Z", 500);
    const secondOutcome = second.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/sensors/readings/downsampled");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).items).toEqual([
      { sensorId: "s1", from: "2026-11-14T00:00:00.000Z", to: "2026-11-21T00:00:00.000Z", buckets: 500 },
      { sensorId: "s2", from: "2026-11-14T00:00:00.000Z", to: "2026-11-21T00:00:00.000Z", buckets: 500 },
    ]);
    expect((await first).buckets[0].min).toBe(1);
    expect(((await secondOutcome) as ApiError).status).toBe(404);
    vi.useRealTimers();
  });

  it("1 センサーだけのときは、今までの単体 API（GET）を呼ぶ", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ bucketSeconds: 60, buckets: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchSensorReadingsDownsampled("only", "2026-11-14T00:00:00.000Z", "2026-11-21T00:00:00.000Z", 500);
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toContain("/api/sensors/only/readings/downsampled?");
    expect(init?.method).toBeUndefined();
    vi.useRealTimers();
  });
});
