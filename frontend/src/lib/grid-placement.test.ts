import { describe, expect, it } from "vitest";

import { bottomRow, columnWidth, findFreeSpot, pointToCell, rectToPixels } from "./grid-placement";

const widget = (gridColumn: number, gridRow: number, gridWidth: number, gridHeight: number) => ({
  gridColumn,
  gridRow,
  gridWidth,
  gridHeight,
});

describe("bottomRow", () => {
  it("ウィジェットが無ければ 1 行目", () => {
    expect(bottomRow([])).toBe(1);
  });
  it("一番下のウィジェットの次の行", () => {
    expect(bottomRow([widget(1, 1, 4, 3), widget(5, 2, 4, 6)])).toBe(8);
  });
});

describe("findFreeSpot", () => {
  it("空いていれば希望の位置", () => {
    expect(findFreeSpot([], 4, 3, 5, 2)).toEqual({ column: 5, row: 2, width: 4, height: 3 });
  });

  it("重なるときは、同じ列のまま下へずらす", () => {
    const spot = findFreeSpot([widget(1, 1, 6, 4)], 3, 2, 2, 1);
    expect(spot).toEqual({ column: 2, row: 5, width: 3, height: 2 });
  });

  it("右にはみ出さないよう列を寄せる", () => {
    expect(findFreeSpot([], 6, 2, 12, 1).column).toBe(7);
  });

  it("幅が 12 を超えても 12 に収める", () => {
    expect(findFreeSpot([], 20, 2, 3, 1)).toMatchObject({ column: 1, width: 12 });
  });

  it("隣と接するだけなら重ならない", () => {
    expect(findFreeSpot([widget(1, 1, 4, 4)], 4, 4, 5, 1).row).toBe(1);
  });
});

describe("ピクセルと列・行の変換", () => {
  const metrics = { containerWidth: 1224, rowHeight: 36, margin: 12 };

  it("1 列の幅（余白を除く）", () => {
    // (1224 - 12 * 13) / 12 = 89
    expect(columnWidth(metrics)).toBe(89);
  });

  it("左上の余白の内側は 1 列目・1 行目", () => {
    expect(pointToCell(metrics, 15, 15)).toEqual({ column: 1, row: 1 });
  });

  it("2 列目・2 行目の中", () => {
    expect(pointToCell(metrics, 12 + 101 + 5, 12 + 48 + 5)).toEqual({ column: 2, row: 2 });
  });

  it("範囲外は端に寄せる", () => {
    expect(pointToCell(metrics, -50, -50)).toEqual({ column: 1, row: 1 });
    expect(pointToCell(metrics, 5000, 100)).toMatchObject({ column: 12 });
  });

  it("矩形をピクセルにする（幅 2 列は 2 列分 + 間の余白）", () => {
    expect(rectToPixels(metrics, { column: 2, row: 1, width: 2, height: 2 })).toEqual({
      left: 12 + 101,
      top: 12,
      width: 89 * 2 + 12,
      height: 36 * 2 + 12,
    });
  });
});
