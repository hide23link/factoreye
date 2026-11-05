import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNow } from "./useNow";

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("マウント時の現在時刻を返す", () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const { result } = renderHook(() => useNow(1000));
    expect(result.current).toBe(new Date("2024-01-01T00:00:00.000Z").getTime());
  });

  it("intervalMs経過ごとに値を更新する", () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const { result } = renderHook(() => useNow(1000));

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(new Date("2024-01-01T00:00:01.000Z").getTime());
  });

  it("アンマウント後はタイマーを止める", () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = renderHook(() => useNow(1000));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
