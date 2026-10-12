import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  fetchSensorReadings: vi.fn(),
}));

import * as api from "../lib/api";
import { DEFAULT_READINGS_LIMIT, useSensorReadings } from "./queries";

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
