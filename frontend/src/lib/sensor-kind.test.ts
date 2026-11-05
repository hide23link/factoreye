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
    ["稼働数", "個", "count"],
    ["ライン1 稼働", "0/1", "state"],
    ["ライン1 稼働時間", "", "measure"],
    ["ライン1 稼働時間", "h", "measure"],
    ["稼働率", "%", "measure"],
    ["モーター運転電流", "A", "measure"],
    ["運転電流", "", "measure"],
    ["生産速度", "個/分", "measure"],
    ["生産時間", "", "measure"],
    ["生産温度", "℃", "measure"],  ] as const)("%s (%s) は %s", (name, unit, kind) => {
    expect(guessSensorKind({ name, unit })).toBe(kind);
  });
});
