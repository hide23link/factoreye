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

  it("1 フレームに何回呼んでも、store の更新（＝全グラフの描き直し）は 1 回だけ。次のフレームで、また 1 回", () => {
    let updates = 0;
    const unsubscribe = useCursorTimeStore.subscribe(() => (updates += 1));
    for (let i = 0; i < 30; i++) requestCursorTime(1000 + i * 10);
    vi.advanceTimersByTime(20);
    expect(updates).toBe(1);
    expect(useCursorTimeStore.getState().time).toBe(1290);
    requestCursorTime(5000);
    requestCursorTime(6000);
    vi.advanceTimersByTime(20);
    expect(updates).toBe(2);
    unsubscribe();
  });

  it("同じ時刻を続けて入れても、更新は 1 回（同じ時刻では、描き直さない）", () => {
    let updates = 0;
    const unsubscribe = useCursorTimeStore.subscribe(() => (updates += 1));
    requestCursorTime(1000, 1000);
    vi.advanceTimersByTime(20);
    requestCursorTime(1200, 1000); // 同じ区間に丸まる
    vi.advanceTimersByTime(20);
    expect(updates).toBe(1);
    unsubscribe();
  });
});

describe("useCursorTimeStore の owner（カーソルを動かしたグラフ）", () => {
  it("最初は null。requestCursorTime は、最後に呼んだグラフの ID を owner にする", () => {
    expect(useCursorTimeStore.getState().owner).toBeNull();
    requestCursorTime(1000, 0, "a");
    requestCursorTime(2000, 0, "b");
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState()).toMatchObject({ time: 2000, owner: "b" });
  });

  it("同じ時刻でも、動かしたグラフが変われば owner が切り替わる", () => {
    useCursorTimeStore.getState().setTime(500, "a");
    useCursorTimeStore.getState().setTime(500, "b");
    expect(useCursorTimeStore.getState().owner).toBe("b");
  });

  it("reset で time と owner の両方が null に戻る", () => {
    useCursorTimeStore.getState().setTime(500, "a");
    useCursorTimeStore.getState().reset();
    expect(useCursorTimeStore.getState()).toMatchObject({ time: null, owner: null });
  });

  it("reset の直前に予約した古い owner は、reset のあとに入らない", () => {
    requestCursorTime(1000, 0, "a");
    useCursorTimeStore.getState().reset();
    vi.advanceTimersByTime(20);
    expect(useCursorTimeStore.getState()).toMatchObject({ time: null, owner: null });
  });
});

