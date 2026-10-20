import { describe, expect, it } from "vitest";

import { isImeComposing } from "./ime";

describe("isImeComposing", () => {
  it("変換中（isComposing）は true", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeComposing({ isComposing: true })).toBe(true);
  });
  it("keyCode 229 は true", () => {
    expect(isImeComposing({ keyCode: 229 })).toBe(true);
    expect(isImeComposing({ nativeEvent: { keyCode: 229 } })).toBe(true);
  });
  it("通常の Enter は false", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 }, keyCode: 13 })).toBe(false);
  });
});
