import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeAlarm,
  createSensor,
  deleteSensor,
  fetchSensorReadingsAggregate,
  fetchSensors,
} from "./api";

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
