import { afterEach, describe, expect, it, vi } from "vitest";

import { clampShelfPosition, isShelfPositionInside, loadShelfPosition, saveShelfPosition } from "./shelf-position";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("clampShelfPosition", () => {
  it("画面内ならそのまま", () => {
    expect(clampShelfPosition({ x: 100, y: 200 }, 1280, 800)).toEqual({ x: 100, y: 200 });
  });
  it("左・上にはみ出したら 0 に寄せる", () => {
    expect(clampShelfPosition({ x: -50, y: -10 }, 1280, 800)).toEqual({ x: 0, y: 0 });
  });
  it("右にはみ出したら、窓の幅が収まる位置（1280 − 272）に寄せる", () => {
    expect(clampShelfPosition({ x: 5000, y: 10 }, 1280, 800).x).toBe(1008);
  });
  it("下にはみ出したら、見出しが画面内に残る位置（800 − 44）に寄せる", () => {
    expect(clampShelfPosition({ x: 0, y: 5000 }, 1280, 800).y).toBe(756);
  });
});

describe("isShelfPositionInside", () => {
  it("収まっていれば true、はみ出していれば false", () => {
    expect(isShelfPositionInside({ x: 10, y: 10 }, 1280, 800)).toBe(true);
    expect(isShelfPositionInside({ x: 1100, y: 10 }, 1280, 800)).toBe(false);
  });
});

describe("保存と読み込み", () => {
  it("保存した位置を読める。null で消せる", () => {
    saveShelfPosition({ x: 300, y: 120 });
    expect(loadShelfPosition(1280, 800)).toEqual({ x: 300, y: 120 });
    saveShelfPosition(null);
    expect(loadShelfPosition(1280, 800)).toBeNull();
  });

  it("いまの画面の外の位置は、読み込まない（既定の場所に戻す）", () => {
    saveShelfPosition({ x: 1100, y: 100 });
    expect(loadShelfPosition(1024, 768)).toBeNull();
  });

  it("壊れた値は無視する", () => {
    window.localStorage.setItem("factoreye.sensorShelfPosition", "{oops");
    expect(loadShelfPosition(1280, 800)).toBeNull();
    window.localStorage.setItem("factoreye.sensorShelfPosition", JSON.stringify({ x: "a", y: 1 }));
    expect(loadShelfPosition(1280, 800)).toBeNull();
  });

  it("localStorage にアクセスできなくても（例外）、読み書きで例外を出さない", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadShelfPosition(1280, 800)).toBeNull();
    expect(() => saveShelfPosition({ x: 1, y: 1 })).not.toThrow();
    expect(() => saveShelfPosition(null)).not.toThrow();
  });
});
