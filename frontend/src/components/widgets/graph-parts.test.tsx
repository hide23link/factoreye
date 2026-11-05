import { describe, expect, it } from "vitest";

import { formatTooltipValue } from "./graph-parts";

describe("formatTooltipValue", () => {
  it("長い小数は有効数字 4 桁に丸め、単位を付ける", () => {
    expect(formatTooltipValue(83.60231701333902, "℃")).toBe("83.6 ℃");
  });
  it("単位が無ければ、数字だけ", () => {
    expect(formatTooltipValue(5.991, undefined)).toBe("5.991");
    expect(formatTooltipValue(5.991, "")).toBe("5.991");
  });
  it("数値にならない値は、そのまま文字にする", () => {
    expect(formatTooltipValue("abc", "℃")).toBe("abc ℃");
  });
  it("整数や大きな値も壊れない", () => {
    expect(formatTooltipValue(1234, "個")).toBe("1234 個");
    expect(formatTooltipValue(1234567, "個")).toBe("1235000 個");
  });
});
