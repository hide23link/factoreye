import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DownsampledReadings } from "./api";
import { BATCH_WINDOW_MS, MAX_BATCH_ITEMS, createDownsampleBatcher, type DownsampleBatchResult, type DownsampleRequest } from "./downsample-batcher";
import { ApiError } from "./errors";

const reading = (seed: number): DownsampledReadings => ({
  bucketSeconds: 60,
  buckets: [{ start: "2026-11-21T00:00:00Z", min: seed, avg: seed, max: seed, count: 1 }],
});
const req = (sensorId: string, to = "2026-11-21T00:00:00Z"): DownsampleRequest => ({
  sensorId,
  from: "2026-11-14T00:00:00Z",
  to,
  buckets: 500,
});
const ok = (items: DownsampleRequest[]): DownsampleBatchResult[] =>
  items.map((item) => ({ sensorId: item.sensorId, status: 200, data: reading(item.sensorId.length) }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createDownsampleBatcher", () => {
  it("同じ時間内の複数の取得を、まとめ API 1 回にして、それぞれに自分の結果を返す", async () => {
    const fetchOne = vi.fn();
    const fetchMany = vi.fn(async (items: DownsampleRequest[]) => ok(items));
    const fetch = createDownsampleBatcher({ fetchOne, fetchMany });

    const promises = [fetch(req("a")), fetch(req("bb")), fetch(req("ccc"))];
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    const results = await Promise.all(promises);

    expect(fetchMany).toHaveBeenCalledTimes(1);
    expect(fetchMany.mock.calls[0][0].map((i) => i.sensorId)).toEqual(["a", "bb", "ccc"]);
    expect(fetchOne).not.toHaveBeenCalled();
    expect(results.map((r) => r.buckets[0].min)).toEqual([1, 2, 3]);
  });

  it("1 件だけのときは、今までの単体 API を使う", async () => {
    const fetchOne = vi.fn(async () => reading(9));
    const fetchMany = vi.fn();
    const fetch = createDownsampleBatcher({ fetchOne, fetchMany });

    const promise = fetch(req("a"));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);

    expect((await promise).buckets[0].min).toBe(9);
    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(fetchMany).not.toHaveBeenCalled();
  });

  it("同じ取得（センサー・範囲・区間数）は 1 件にして、結果を分け合う", async () => {
    const fetchMany = vi.fn(async (items: DownsampleRequest[]) => ok(items));
    const fetch = createDownsampleBatcher({ fetchOne: vi.fn(), fetchMany });

    const promises = [fetch(req("a")), fetch(req("a")), fetch(req("bb"))];
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    const results = await Promise.all(promises);

    expect(fetchMany.mock.calls[0][0]).toHaveLength(2);
    expect(results[0]).toEqual(results[1]);
  });

  it("範囲が違う取得は、同じセンサーでも別の件としてまとめて送る", async () => {
    const fetchMany = vi.fn(async (items: DownsampleRequest[]) => ok(items));
    const fetch = createDownsampleBatcher({ fetchOne: vi.fn(), fetchMany });

    const promises = [fetch(req("a")), fetch(req("a", "2026-11-21T00:00:01Z"))];
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await Promise.all(promises);

    expect(fetchMany.mock.calls[0][0]).toHaveLength(2);
  });

  it("1 件の失敗は、その件を呼んだ人だけを失敗にする（status を持つ ApiError）", async () => {
    const fetchMany = vi.fn(async (items: DownsampleRequest[]) =>
      items.map((item): DownsampleBatchResult =>
        item.sensorId === "bad"
          ? { sensorId: item.sensorId, status: 404, data: null, detail: "sensor not found" }
          : { sensorId: item.sensorId, status: 200, data: reading(1) },
      ),
    );
    const fetch = createDownsampleBatcher({ fetchOne: vi.fn(), fetchMany });

    const good = fetch(req("good"));
    const bad = fetch(req("bad"));
    const badOutcome = bad.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);

    expect((await good).bucketSeconds).toBe(60);
    const error = await badOutcome;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it("まとめ API の通信自体が失敗したら、全員が同じ失敗になる", async () => {
    const fetchMany = vi.fn().mockRejectedValue(new ApiError(500, "boom"));
    const fetch = createDownsampleBatcher({ fetchOne: vi.fn(), fetchMany });

    const outcomes = [fetch(req("a")), fetch(req("b"))].map((p) => p.catch((e: unknown) => e));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);

    for (const error of await Promise.all(outcomes)) expect((error as ApiError).status).toBe(500);
  });

  it("まとめ API が無い（404）ときは単体 API に戻し、以後はまとめない", async () => {
    const fetchOne = vi.fn(async (item: DownsampleRequest) => reading(item.sensorId.length));
    const fetchMany = vi.fn().mockRejectedValue(new ApiError(404, "not found"));
    const fetch = createDownsampleBatcher({ fetchOne, fetchMany });

    const first = [fetch(req("a")), fetch(req("bb"))];
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect((await Promise.all(first)).map((r) => r.buckets[0].min)).toEqual([1, 2]);

    const second = [fetch(req("a")), fetch(req("bb"))];
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await Promise.all(second);

    expect(fetchMany).toHaveBeenCalledTimes(1);
    expect(fetchOne).toHaveBeenCalledTimes(4);
  });

  it("50 件を超えたら、50 件ずつのまとめ API に分ける", async () => {
    const fetchMany = vi.fn(async (items: DownsampleRequest[]) => ok(items));
    const fetch = createDownsampleBatcher({ fetchOne: vi.fn(), fetchMany });

    const promises = Array.from({ length: MAX_BATCH_ITEMS + 5 }, (_, i) => fetch(req(`s${i}`)));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await Promise.all(promises);

    expect(fetchMany.mock.calls.map((call) => call[0].length)).toEqual([MAX_BATCH_ITEMS, 5]);
  });
});
