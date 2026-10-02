import { describe, expect, it } from "vitest";

import { formatChartTime } from "./time";

describe("formatChartTime", () => {
  // 2024-03-15 09:05:00 JST
  const ms = new Date("2024-03-15T00:05:00.000Z").getTime();

  it("24時間以下の範囲では時刻のみを表示する（日付を含まない）", () => {
    const result = formatChartTime(ms, 24);
    expect(result).not.toMatch(/\d{4}/); // 年を含まない
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it("24時間を超える範囲では月日も表示する", () => {
    const result = formatChartTime(ms, 168);
    expect(result).toMatch(/3\/15/);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });
});
