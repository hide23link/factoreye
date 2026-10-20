import { describe, expect, it } from "vitest";

import { guessSensorKind } from "./sensor-kind";

describe("guessSensorKind", () => {
  it.each([
    ["乾燥炉 温度", "℃", "measure"],
    ["ライン1 生産数", "個", "count"],
    ["出来高", "", "count"],
    ["A", "pcs", "count"],
    ["ライン1 稼働", "", "state"],
    ["Line1 running", "", "state"],
    ["稼働数", "個", "state"],
  ] as const)("%s (%s) は %s", (name, unit, kind) => {
    expect(guessSensorKind({ name, unit })).toBe(kind);
  });
});
