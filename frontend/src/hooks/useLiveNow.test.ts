import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRefreshStore } from "../store/useRefreshStore";
import { useLiveNow } from "./useLiveNow";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  useRefreshStore.setState({ choice: "graph", manualAt: 0 });
});

const T0 = Date.parse("2024-01-01T00:00:00.000Z");

describe("useLiveNow", () => {
  it("各グラフの設定のときは、グラフの間隔で進む", () => {
    const { result } = renderHook(() => useLiveNow(30000));
    act(() => void vi.advanceTimersByTime(30000));
    expect(result.current).toBe(T0 + 30000);
  });

  it("10 秒を選ぶと、10 秒ごとに進む", () => {
    useRefreshStore.setState({ choice: "10" });
    const { result } = renderHook(() => useLiveNow(30000));
    act(() => void vi.advanceTimersByTime(10000));
    expect(result.current).toBe(T0 + 10000);
  });

  it("Off は進まず、⟳ を押したときだけ進む", () => {
    useRefreshStore.setState({ choice: "off" });
    const { result } = renderHook(() => useLiveNow(30000));
    act(() => void vi.advanceTimersByTime(120000));
    expect(result.current).toBe(T0);
    act(() => useRefreshStore.getState().markManualRefresh());
    expect(result.current).toBe(T0 + 120000);
  });
});
