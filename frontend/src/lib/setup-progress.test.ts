import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSetupProgress,
  completedCount,
  formatWaitTime,
  INITIAL_PROGRESS,
  loadSetupProgress,
  saveSetupProgress,
  stepBarStates,
} from "./setup-progress";

const sensor = { id: "s1", name: "デモ", ingestKey: "demo-k3x9", unit: "°C" };

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("setup-progress（セットアップガイドの進み具合）", () => {
  it("保存した進み具合を、そのまま読み戻せる", () => {
    saveSetupProgress({ step: 2, sensor, dashboardId: null });
    expect(loadSetupProgress()).toEqual({ step: 2, sensor, dashboardId: null });
  });

  it("何も無い・壊れている・つじつまが合わないときは、最初の状態に戻す", () => {
    expect(loadSetupProgress()).toEqual(INITIAL_PROGRESS);
    window.localStorage.setItem("factoreye.setup-guide", "{こわれた");
    expect(loadSetupProgress()).toEqual(INITIAL_PROGRESS);
    // 段階 2 なのにセンサーが無い
    saveSetupProgress({ step: 2, sensor: null, dashboardId: null });
    expect(loadSetupProgress()).toEqual(INITIAL_PROGRESS);
    // 完了なのにダッシュボードが無い
    saveSetupProgress({ step: 4, sensor, dashboardId: null });
    expect(loadSetupProgress()).toEqual(INITIAL_PROGRESS);
  });

  it("消すと、最初の状態になる", () => {
    saveSetupProgress({ step: 3, sensor, dashboardId: null });
    clearSetupProgress();
    expect(loadSetupProgress()).toEqual(INITIAL_PROGRESS);
  });

  it("ブラウザが保存を許していなくても、例外にしない", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => saveSetupProgress({ step: 2, sensor, dashboardId: null })).not.toThrow();
    expect(loadSetupProgress()).toEqual(INITIAL_PROGRESS);
  });

  it("済んだ段階の数と、4 本の帯の状態", () => {
    expect(completedCount(1)).toBe(0);
    expect(completedCount(2)).toBe(1);
    expect(completedCount(4)).toBe(4);
    expect(stepBarStates(2)).toEqual(["done", "current", "todo", "todo"]);
    expect(stepBarStates(4)).toEqual(["done", "done", "done", "done"]);
  });

  it("待ち時間は分:秒で、負の値は 00:00", () => {
    expect(formatWaitTime(42_000)).toBe("00:42");
    expect(formatWaitTime(125_900)).toBe("02:05");
    expect(formatWaitTime(-5)).toBe("00:00");
  });
});
