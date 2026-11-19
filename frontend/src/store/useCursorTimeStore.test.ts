import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelPendingCursorTime, requestCursorTime, useCursorTimeStore } from "./useCursorTimeStore";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cancelPendingCursorTime();
  useCursorTimeStore.getState().reset();
  vi.useRealTimers();
});

describe("useCursorTimeStore（全グラフで共有するカーソルの時刻）", () => {
  it("最初は null（現在位置＝表示範囲の右端に、今に追従して出す）", () => {
    expect(useCursorTimeStore.getState().time).toBeNull();
  });

  it("時刻を入れると、その時刻に固定する。reset（今に戻す）で null に戻る", () => {
    useCursorTimeStore.getState().setTime(123);
    expect(useCursorTimeStore.getState().time).toBe(123);
    useCursorTimeStore.getState().reset();
    expect(useCursorTimeStore.getState().time).toBeNull();
  });

  it("requestCursorTime は、すぐには入れず、次の描画の 1 回にまとめて入れる（途中の時刻は捨てる）", () => {
    requestCursorTime(1000);
    requestCursorTime(2000);
    requestCursorTime(3000);
    expect(useCursorTimeStore.getState().time).toBeNull();
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState().time).toBe(3000);
  });

  it("グラフの 1 区間（stepMs）に丸めて入れる", () => {
    requestCursorTime(1_000_000 + 400, 1000);
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState().time).toBe(1_000_000);
    requestCursorTime(1_000_000 + 600, 1000);
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState().time).toBe(1_001_000);
  });

  it("今に戻したとき、遅れて予約の時刻が入って、また動いてしまうことはない", () => {
    requestCursorTime(5000);
    useCursorTimeStore.getState().reset();
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState().time).toBeNull();
  });
});
