import { describe, expect, it } from "vitest";

import { clampPlacement } from "./widget-layout";

describe("clampPlacement（位置とサイズを範囲に収める）", () => {
  it("範囲内の値はそのまま", () => {
    expect(clampPlacement({ column: 3, row: 2, width: 4, height: 5 })).toEqual({ column: 3, row: 2, width: 4, height: 5 });
  });

  it("右にはみ出す列は、幅に合わせて左へ寄せる（12 列の中に収まる）", () => {
    expect(clampPlacement({ column: 11, row: 1, width: 4, height: 2 })).toEqual({ column: 9, row: 1, width: 4, height: 2 });
  });

  it("幅・高さ・列・行の下限と上限", () => {
    expect(clampPlacement({ column: 0, row: 0, width: 0, height: 0 })).toEqual({ column: 1, row: 1, width: 1, height: 1 });
    expect(clampPlacement({ column: 1, row: 1, width: 20, height: 99 })).toEqual({ column: 1, row: 1, width: 12, height: 40 });
  });
});
