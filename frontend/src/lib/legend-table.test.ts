import { describe, expect, it } from "vitest";

import type { GraphRow } from "./graph-series";
import { isDimmed, toggleSelection, valueAtCursor } from "./legend-table";

const rows: GraphRow[] = [
  { time: 1000, a: 5 },
  { time: 2000, a: 7, b: 1 },
  { time: 3000, b: 2 },
];

describe("valueAtCursor", () => {
  it("カーソルに近い行の値を返す", () => {
    expect(valueAtCursor(rows, "a", 1900, 300)).toBe(7);
    expect(valueAtCursor(rows, "b", 2800, 300)).toBe(2);
  });
  it("近い行が許容より遠ければ値なし", () => {
    expect(valueAtCursor(rows, "a", 5000, 300)).toBeUndefined();
  });
  it("そのセンサーの値が 1 つも無ければ値なし", () => {
    expect(valueAtCursor(rows, "c", 2000, 300)).toBeUndefined();
  });
  it("同じ値が複数の行にあっても、いちばん近い差で判定する", () => {
    const same: GraphRow[] = [{ time: 0, a: 5 }, { time: 9000, a: 5 }];
    expect(valueAtCursor(same, "a", 8900, 200)).toBe(5);
  });
});

describe("toggleSelection", () => {
  it("通常クリックでその 1 本だけにし、もう一度で解除する", () => {
    expect(toggleSelection([], "a", false)).toEqual(["a"]);
    expect(toggleSelection(["a"], "b", false)).toEqual(["b"]);
    expect(toggleSelection(["a"], "a", false)).toEqual([]);
  });
  it("複数選択のときは足す・外す。空になれば全部に戻る", () => {
    expect(toggleSelection(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleSelection(["a", "b"], "a", true)).toEqual(["b"]);
    expect(toggleSelection(["a"], "a", true)).toEqual([]);
  });
  it("2 本選んでいるとき、通常クリックはその 1 本だけにする", () => {
    expect(toggleSelection(["a", "b"], "a", false)).toEqual(["a"]);
  });
});

describe("isDimmed", () => {
  it("選択が空なら薄くしない", () => {
    expect(isDimmed([], "a")).toBe(false);
  });
  it("選ばれていない線だけ薄くする", () => {
    expect(isDimmed(["a"], "a")).toBe(false);
    expect(isDimmed(["a"], "b")).toBe(true);
  });
});
