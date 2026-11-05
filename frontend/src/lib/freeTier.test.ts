import { describe, expect, it } from "vitest";

import { isFreeTierLimitError } from "./freeTier";

describe("isFreeTierLimitError", () => {
  it("402 のエラーメッセージを上限到達と判定する", () => {
    const e = new Error('POST /api/sensors failed: 402 {"detail":"free tier limit reached"}');
    expect(isFreeTierLimitError(e)).toBe(true);
  });

  it("402 以外（409 など）は上限到達と判定しない", () => {
    expect(isFreeTierLimitError(new Error("POST /api/sensors failed: 409 conflict"))).toBe(false);
    expect(isFreeTierLimitError(new Error("Network error"))).toBe(false);
  });
});
