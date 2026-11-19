import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelPendingCursorTime, useCursorTimeStore } from "../store/useCursorTimeStore";
import { withSharedCursor } from "./shared-cursor";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cancelPendingCursorTime();
  useCursorTimeStore.getState().reset();
  vi.useRealTimers();
});

describe("withSharedCursor（グラフの上の操作で、共有のカーソルの時刻を更新する）", () => {
  it("マウスの移動・タップ・指のドラッグで、その位置の時刻（activeLabel）を、グラフの 1 区間に丸めて共有の時刻にする", () => {
    const handlers = withSharedCursor(true, 1000, {});
    handlers.onMouseMove?.({ activeLabel: 10_400 });
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState().time).toBe(10_000);
    handlers.onClick?.({ activeLabel: 20_000 });
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState().time).toBe(20_000);
    handlers.onTouchMove?.({ activeLabel: 30_000 });
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState().time).toBe(30_000);
  });

  it("元のイベント（ドラッグで期間を選ぶ onMouseMove）も呼ぶ", () => {
    const base = { onMouseMove: vi.fn(), onMouseDown: vi.fn() };
    const handlers = withSharedCursor(true, 1000, base);
    handlers.onMouseMove?.({ activeLabel: 5000 });
    expect(base.onMouseMove).toHaveBeenCalledWith({ activeLabel: 5000 });
    expect(handlers.onMouseDown).toBe(base.onMouseDown);
  });

  it("グラフの外（時刻が無い）では、共有の時刻を変えない（マウスが外れても、カーソルはその位置に残す）", () => {
    useCursorTimeStore.getState().setTime(7000);
    const handlers = withSharedCursor(true, 1000, {});
    handlers.onMouseMove?.(undefined);
    handlers.onMouseMove?.({});
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState().time).toBe(7000);
  });

  it("リンクの画面（enabled = false）では、元のイベントをそのまま返す（共有の時刻を触らない）", () => {
    const base = { onMouseMove: vi.fn() };
    const handlers = withSharedCursor(false, 1000, base);
    expect(handlers).toBe(base);
  });
});
