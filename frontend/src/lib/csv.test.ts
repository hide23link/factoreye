import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCsv, CSV_BOM, csvFileName, downloadCsv, escapeCsvField, toJstFileStamp, toJstIso } from "./csv";

describe("escapeCsvField", () => {
  it("普通の文字・数字はそのまま、null は空欄", () => {
    expect(escapeCsvField("温度")).toBe("温度");
    expect(escapeCsvField(12.5)).toBe("12.5");
    expect(escapeCsvField(null)).toBe("");
  });
  it("カンマ・改行・引用符を含むときは囲み、引用符は 2 つにする", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField("a\nb")).toBe('"a\nb"');
    expect(escapeCsvField('5" 配管')).toBe('"5"" 配管"');
  });
});

describe("式の無害化（CSV インジェクション）", () => {
  it("文字列の欄の先頭が = + - @ タブ CR のときは、先頭に ' を付ける", () => {
    expect(escapeCsvField("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(escapeCsvField("+1")).toBe("'+1");
    expect(escapeCsvField("-cmd")).toBe("'-cmd");
    expect(escapeCsvField("@SUM(1)")).toBe("'@SUM(1)");
    expect(escapeCsvField("\tx")).toBe("'\tx");
    expect(escapeCsvField("\rx")).toBe(`"'\rx"`);
  });
  it("数値の欄（負数）や、途中に記号がある文字列はそのまま", () => {
    expect(escapeCsvField(-5.5)).toBe("-5.5");
    expect(escapeCsvField("a=b")).toBe("a=b");
    expect(escapeCsvField("2026-11-20T10:00:00+09:00")).toBe("2026-11-20T10:00:00+09:00");
  });
});

describe("buildCsv", () => {
  it("BOM 付き・CRLF・最後に改行。行数は入力と一致する", () => {
    const csv = buildCsv([["時刻", "温度 (℃)"], ["2026-11-20T10:00:00+09:00", 1.5], ["2026-11-20T10:01:00+09:00", null]]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines).toEqual(["時刻,温度 (℃)", "2026-11-20T10:00:00+09:00,1.5", "2026-11-20T10:01:00+09:00,", ""]);
  });
});

describe("時刻・ファイル名", () => {
  it("UTC の時刻を JST の ISO 8601 にする（日付をまたぐ）", () => {
    expect(toJstIso(Date.UTC(2026, 10, 20, 16, 5, 7))).toBe("2026-11-21T01:05:07+09:00");
    expect(toJstFileStamp(Date.UTC(2026, 10, 20, 16, 5))).toBe("20261121-0105");
  });
  it("ファイル名に使えない文字は _ にし、空なら data", () => {
    expect(csvFileName("温度/湿度: A", "直近1時間")).toBe("温度_湿度_ A_直近1時間.csv");
    expect(csvFileName("  ", "直近1時間")).toBe("data_直近1時間.csv");
  });
});

describe("downloadCsv", () => {
  afterEach(() => vi.restoreAllMocks());
  it("Blob を作り、a 要素をクリックして保存させる", () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    downloadCsv("a.csv", buildCsv([["x"]]));
    expect(create).toHaveBeenCalledTimes(1);
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toContain("text/csv");
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
