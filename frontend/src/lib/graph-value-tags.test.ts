import { describe, expect, it } from "vitest";
import { layoutValueTags, TAG_BLOCK_HEIGHT, TAG_CENTER_OFFSET, TAG_GAP } from "./graph-value-tags";

const STEP = TAG_BLOCK_HEIGHT + TAG_GAP;

describe("layoutValueTags（今の値の札の高さ）", () => {
  it("重ならなければ、数字の枠の真ん中が、線の最後の点の高さに来る", () => {
    expect(layoutValueTags([50, 150], 300)).toEqual([50 - TAG_CENTER_OFFSET, 150 - TAG_CENTER_OFFSET]);
  });

  it("値が近い札は、重ならないように下へずらす（渡した順のまま返す）", () => {
    expect(layoutValueTags([55, 50, undefined], 300)).toEqual([40 + STEP, 40, 40 + STEP * 2]);
  });

  it("下にはみ出す札は、上へ戻す", () => {
    const tops = layoutValueTags([195, 198], 200);
    expect(tops[1]).toBe(200 - TAG_BLOCK_HEIGHT);
    expect(tops[0]).toBe(200 - TAG_BLOCK_HEIGHT - STEP);
  });

  it("上端より上には出さない", () => {
    expect(layoutValueTags([0], 200)).toEqual([0]);
  });
});
