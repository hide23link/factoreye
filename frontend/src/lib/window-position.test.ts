import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clampWindowPosition,
  clampWindowSize,
  isWindowPositionInside,
  loadWindowPosition,
  loadWindowSize,
  saveWindowPosition,
  saveWindowSize,
} from "./window-position";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("clampWindowPosition", () => {
  it("画面内ならそのまま", () => {
    expect(clampWindowPosition("shelf", { x: 100, y: 200 }, 1280, 800)).toEqual({ x: 100, y: 200 });
  });
  it("左・上にはみ出したら 0 に寄せる", () => {
    expect(clampWindowPosition("shelf", { x: -50, y: -10 }, 1280, 800)).toEqual({ x: 0, y: 0 });
  });
  it("右にはみ出したら、窓の幅が収まる位置（1280 − 272）に寄せる", () => {
    expect(clampWindowPosition("shelf", { x: 5000, y: 10 }, 1280, 800).x).toBe(1008);
  });
  it("広げた窓は、その幅と縁の 8px が収まる位置（1280 − 570 − 8）で止める", () => {
    expect(clampWindowPosition("shelf", { x: 5000, y: 10 }, 1280, 800, 570).x).toBe(702);
  });
  it("広げた窓が画面より広いときは、左端（0）に置く", () => {
    expect(clampWindowPosition("shelf", { x: 300, y: 10 }, 500, 800, 600).x).toBe(0);
  });
  it("下にはみ出したら、見出しが画面内に残る位置（800 − 44）に寄せる", () => {
    expect(clampWindowPosition("shelf", { x: 0, y: 5000 }, 1280, 800).y).toBe(756);
  });
});

describe("isWindowPositionInside", () => {
  it("収まっていれば true、はみ出していれば false", () => {
    expect(isWindowPositionInside("shelf", { x: 10, y: 10 }, 1280, 800)).toBe(true);
    expect(isWindowPositionInside("shelf", { x: 1100, y: 10 }, 1280, 800)).toBe(false);
  });
});

describe("保存と読み込み", () => {
  it("保存した位置を読める。null で消せる", () => {
    saveWindowPosition("shelf", { x: 300, y: 120 });
    expect(loadWindowPosition("shelf", 1280, 800)).toEqual({ x: 300, y: 120 });
    saveWindowPosition("shelf", null);
    expect(loadWindowPosition("shelf", 1280, 800)).toBeNull();
  });

  it("いまの画面の外の位置は、読み込まない（既定の場所に戻す）", () => {
    saveWindowPosition("shelf", { x: 1100, y: 100 });
    expect(loadWindowPosition("shelf", 1024, 768)).toBeNull();
  });

  it("壊れた値は無視する", () => {
    window.localStorage.setItem("factoreye.sensorShelfPosition", "{oops");
    expect(loadWindowPosition("shelf", 1280, 800)).toBeNull();
    window.localStorage.setItem("factoreye.sensorShelfPosition", JSON.stringify({ x: "a", y: 1 }));
    expect(loadWindowPosition("shelf", 1280, 800)).toBeNull();
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
    expect(loadWindowPosition("shelf", 1280, 800)).toBeNull();
    expect(() => saveWindowPosition("shelf", { x: 1, y: 1 })).not.toThrow();
    expect(() => saveWindowPosition("shelf", null)).not.toThrow();
  });
});

describe("設定パネル（幅 316px）", () => {
  it("右は 画面幅 − 316 までに制限し、保存のキーは棚と別", () => {
    expect(clampWindowPosition("panel", { x: 5000, y: 0 }, 1280, 800).x).toBe(964);
    saveWindowPosition("panel", { x: 100, y: 100 });
    expect(loadWindowPosition("panel", 1280, 800)).toEqual({ x: 100, y: 100 });
    expect(loadWindowPosition("shelf", 1280, 800)).toBeNull();
  });
});

describe("clampWindowSize（最小〜画面内に収まる最大）", () => {
  const pos = { x: 100, y: 50 };

  it("範囲内ならそのまま", () => {
    expect(clampWindowSize("shelf", { width: 400, height: 500 }, pos, 1280, 800)).toEqual({ width: 400, height: 500 });
  });

  it("最小（棚は幅 272・パネルは幅 316、高さは 160）より小さくしない", () => {
    expect(clampWindowSize("shelf", { width: 10, height: 10 }, pos, 1280, 800)).toEqual({ width: 272, height: 160 });
    expect(clampWindowSize("panel", { width: 10, height: 10 }, pos, 1280, 800)).toEqual({ width: 316, height: 160 });
  });

  it("最大は、位置から画面の右・下の縁（間隔 8px）まで", () => {
    expect(clampWindowSize("shelf", { width: 9999, height: 9999 }, pos, 1280, 800)).toEqual({
      width: 1280 - 100 - 8,
      height: 800 - 50 - 8,
    });
  });

  it("画面が最小より狭くても、最小を優先する（それ以上は小さくしない）", () => {
    expect(clampWindowSize("shelf", { width: 500, height: 500 }, { x: 0, y: 0 }, 200, 100)).toEqual({ width: 272, height: 160 });
  });

  it("小数は丸める", () => {
    expect(clampWindowSize("shelf", { width: 300.6, height: 200.4 }, pos, 1280, 800)).toEqual({ width: 301, height: 200 });
  });
});

describe("大きさの保存と読み込み", () => {
  it("保存した大きさを読める。null で消せる", () => {
    saveWindowSize("shelf", { width: 400, height: 500 });
    expect(loadWindowSize("shelf")).toEqual({ width: 400, height: 500 });
    expect(loadWindowSize("panel")).toBeNull(); // 窓ごとに別
    saveWindowSize("shelf", null);
    expect(loadWindowSize("shelf")).toBeNull();
  });

  it.each([
    ["JSON ではない", "{oops"],
    ["数値ではない", JSON.stringify({ width: "400", height: 500 })],
    ["有限ではない", '{"width": 1e999, "height": 500}'],
    ["最小より小さい幅", JSON.stringify({ width: 100, height: 500 })],
    ["最小より小さい高さ", JSON.stringify({ width: 400, height: 50 })],
    ["オブジェクトではない", "123"],
  ])("壊れた値（%s）は読み込まない（既定の大きさ）", (_name, raw) => {
    window.localStorage.setItem("factoreye.sensorShelfSize", raw);
    expect(loadWindowSize("shelf")).toBeNull();
  });

  it("localStorage が使えない環境でも、例外を出さない", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(loadWindowSize("shelf")).toBeNull();
    expect(() => saveWindowSize("shelf", { width: 400, height: 500 })).not.toThrow();
  });
});
