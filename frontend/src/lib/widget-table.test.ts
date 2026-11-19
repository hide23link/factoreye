import { describe, expect, it } from "vitest";

import { buildCsv } from "./csv";
import { buildCsvRows, buildTableRows, columnTitle, formatTableTime, formatTableValue, linkMinutes, periodLabel, type TableSeries } from "./widget-table";

const b = (start: string, avg: number, max = avg, min = avg) => ({ start, avg, max, min });

const temp: TableSeries = {
  name: "温度",
  unit: "℃",
  buckets: [b("2026-11-20T01:00:00.000Z", 20, 25, 15), b("2026-11-20T01:01:00.000Z", 21, 26, 16)],
};
const humid: TableSeries = { name: "湿度", unit: "", buckets: [b("2026-11-20T01:01:00.000Z", 50), b("2026-11-20T01:02:00.000Z", 51)] };

describe("buildTableRows", () => {
  it("1 本なら、区間の数と同じ行数（古い順）", () => {
    const rows = buildTableRows([temp], "avg");
    expect(rows.map((r) => r.values)).toEqual([[20], [21]]);
    expect(rows[0].timeMs).toBeLessThan(rows[1].timeMs);
  });
  it("集計（最大・最小）を選べる", () => {
    expect(buildTableRows([temp], "max").map((r) => r.values[0])).toEqual([25, 26]);
    expect(buildTableRows([temp], "min").map((r) => r.values[0])).toEqual([15, 16]);
  });
  it("複数は時刻の和集合で、無い欄は null", () => {
    expect(buildTableRows([temp, humid], "avg").map((r) => r.values)).toEqual([
      [20, null],
      [21, 50],
      [null, 51],
    ]);
  });
  it("空の取得は 0 行", () => {
    expect(buildTableRows([{ ...temp, buckets: [] }], "avg")).toEqual([]);
  });
});

describe("CSV の行", () => {
  it("1 行目は名前と単位、続きはデータ。行数 = 1 + 点の数、時刻は JST", () => {
    const series = [temp, humid];
    const rows = buildTableRows(series, "avg");
    const csvRows = buildCsvRows(series, rows);
    expect(csvRows).toHaveLength(1 + rows.length);
    expect(csvRows[0]).toEqual(["時刻(JST,ISO 8601)", "温度 (℃)", "湿度"]);
    expect(csvRows[1]).toEqual(["2026-11-20T10:00:00+09:00", 20, null]);
    expect(buildCsv(csvRows).split("\r\n")).toHaveLength(csvRows.length + 1);
  });
});

describe("表示・期間の文字", () => {
  it("列の見出し・時刻・値", () => {
    expect(columnTitle(temp)).toBe("温度 (℃)");
    expect(formatTableTime(Date.UTC(2026, 10, 20, 1, 5, 9))).toBe("11-20 10:05:09");
    expect(formatTableValue(1.23456)).toBe("1.235");
    expect(formatTableValue(null)).toBe("-");
  });
  it("期間の文字とリンクの分数", () => {
    const bounds = { from: Date.UTC(2026, 10, 20, 1, 0), to: Date.UTC(2026, 10, 20, 2, 0) };
    expect(periodLabel({ mode: "relative", durationMs: 3600_000 }, bounds)).toBe("直近1時間");
    expect(periodLabel({ mode: "relative", durationMs: 90 * 60_000 }, bounds)).toBe("直近90分");
    expect(periodLabel({ mode: "absolute", ...bounds }, bounds)).toBe("20261120-1000-20261120-1100");
    expect(linkMinutes({ mode: "relative", durationMs: 60_000 }, bounds)).toBe(10);
    expect(linkMinutes({ mode: "relative", durationMs: 30 * 86400_000 }, bounds)).toBe(10080);
    expect(linkMinutes({ mode: "absolute", ...bounds }, bounds)).toBe(60);
  });
});
