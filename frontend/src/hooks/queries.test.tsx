import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  fetchSensorReadings: vi.fn(),
  fetchLatestReadings: vi.fn(),
}));

import * as api from "../lib/api";
import { DEFAULT_READINGS_LIMIT, useReadingsHourAgo, useSensorReadings } from "./queries";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSensorReadings の limit", () => {
  it("limit を渡さなければ既定（500）で取る", async () => {
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
    const { wrapper } = setup();
    renderHook(() => useSensorReadings("s1", 1), { wrapper });
    await waitFor(() => expect(api.fetchSensorReadings).toHaveBeenCalled());
    expect(DEFAULT_READINGS_LIMIT).toBe(500);
    expect(api.fetchSensorReadings).toHaveBeenCalledWith("s1", expect.any(String), 500);
  });

  it("limit が違えばクエリキーが分かれ、キャッシュが混ざらない", async () => {
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
    const { client, wrapper } = setup();
    renderHook(
      () => ({ a: useSensorReadings("s1", 1, 1), b: useSensorReadings("s1", 1) }),
      { wrapper },
    );
    await waitFor(() => expect(api.fetchSensorReadings).toHaveBeenCalledTimes(2));
    const keys = client.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toContainEqual(["readings", "s1", 1, 1]);
    expect(keys).toContainEqual(["readings", "s1", 1, 500]);
  });
});

describe("useReadingsHourAgo（1 時間前の値）", () => {
  it("1 時間前の時刻（before）で取り、センサー ID → 値の Map にする", async () => {
    const before = Date.now();
    const at = new Date(before - 3_600_000 - 60_000).toISOString();
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [{ sensorId: "a", value: 21.8, recordedAt: at }], total: 1 });
    const { wrapper } = setup();
    const { result } = renderHook(() => useReadingsHourAgo(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.data?.get("a")).toBe(21.8);
    const asked = new Date(vi.mocked(api.fetchLatestReadings).mock.calls[0][0] as string).getTime();
    expect(Math.abs(asked - (before - 3_600_000))).toBeLessThan(5_000);
  });

  it("1 時間前の時点で、15 分より前から受信が止まっていた値は入れない（止まった古い値との差を変化にしない）", async () => {
    const hourAgo = Date.now() - 3_600_000;
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({
      readings: [
        { sensorId: "fresh", value: 1, recordedAt: new Date(hourAgo - 14 * 60_000).toISOString() },
        { sensorId: "stopped", value: 2, recordedAt: new Date(hourAgo - 16 * 60_000).toISOString() },
      ],
      total: 2,
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useReadingsHourAgo(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect([...(result.current.data?.keys() ?? [])]).toEqual(["fresh"]);
  });
});
