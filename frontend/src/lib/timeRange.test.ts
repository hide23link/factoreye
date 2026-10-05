import { describe, expect, it } from "vitest";

import {
  absoluteRange,
  describeRange,
  fromSearchParams,
  maxRangeMs,
  nowRange,
  panRange,
  resolveRange,
  toSearchParams,
  zoomRange,
} from "./timeRange";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-05T03:00:00.000Z");
const UNLIMITED = Number.POSITIVE_INFINITY;

describe("resolveRange", () => {
  it("直近モードは、右端が今、左端が幅だけ前", () => {
    expect(resolveRange({ mode: "relative", durationMs: HOUR }, NOW)).toEqual({
      from: NOW - HOUR,
      to: NOW,
    });
  });

  it("固定モードは、指定された開始と終了をそのまま返す", () => {
    const range = { mode: "absolute" as const, from: 1000, to: 5000 };
    expect(resolveRange(range, NOW)).toEqual({ from: 1000, to: 5000 });
  });
});

describe("absoluteRange", () => {
  it("終了が開始より後なら固定モードを返す", () => {
    expect(absoluteRange(1000, 2000)).toEqual({ mode: "absolute", from: 1000, to: 2000 });
  });

  it("終了が開始以前、または数値でないときは null", () => {
    expect(absoluteRange(2000, 1000)).toBeNull();
    expect(absoluteRange(1000, 1000)).toBeNull();
    expect(absoluteRange(Number.NaN, 1000)).toBeNull();
  });
});

describe("panRange", () => {
  it("過去へ動かすと、幅の分だけ前へ動き、固定モードになる", () => {
    const next = panRange({ mode: "relative", durationMs: HOUR }, -1, NOW, UNLIMITED);
    expect(next).toEqual({ mode: "absolute", from: NOW - 2 * HOUR, to: NOW - HOUR });
  });

  it("未来へ動かしても、現在時刻より先には行かない", () => {
    const past = { mode: "absolute" as const, from: NOW - 2 * HOUR, to: NOW - HOUR };
    const next = panRange(past, 1, NOW, UNLIMITED);
    expect(next).toEqual({ mode: "absolute", from: NOW - HOUR, to: NOW });
  });

  it("動かした後の幅は、上限を超えない（幅は変わらないので、そのまま）", () => {
    const max = 90 * 24 * HOUR;
    const range = { mode: "absolute" as const, from: NOW - 80 * 24 * HOUR, to: NOW };
    const next = panRange(range, -1, NOW, max);
    expect(next.mode === "absolute" && next.to - next.from).toBe(80 * 24 * HOUR);
  });
});

describe("zoomRange", () => {
  it("直近モードの拡大・縮小は、右端を今のまま幅だけ変える（直近モードのまま）", () => {
    expect(zoomRange({ mode: "relative", durationMs: HOUR }, 0.5, NOW, UNLIMITED)).toEqual({
      mode: "relative",
      durationMs: 30 * MINUTE,
    });
    expect(zoomRange({ mode: "relative", durationMs: HOUR }, 2, NOW, UNLIMITED)).toEqual({
      mode: "relative",
      durationMs: 2 * HOUR,
    });
  });

  it("固定モードの拡大・縮小は、中心を保つ", () => {
    const range = { mode: "absolute" as const, from: NOW - 2 * HOUR, to: NOW };
    const center = NOW - HOUR;
    const next = zoomRange(range, 0.5, NOW, UNLIMITED);
    expect(next).toEqual({
      mode: "absolute",
      from: center - HOUR / 2,
      to: center + HOUR / 2,
    });
  });

  it("縮小しすぎても、最小の幅（1 分）を下回らない", () => {
    const next = zoomRange({ mode: "relative", durationMs: MINUTE }, 0.1, NOW, UNLIMITED);
    expect(next).toEqual({ mode: "relative", durationMs: MINUTE });
  });

  it("拡大しても、上限を超えない", () => {
    const max = 90 * 24 * HOUR;
    const next = zoomRange({ mode: "relative", durationMs: 60 * 24 * HOUR }, 2, NOW, max);
    expect(next).toEqual({ mode: "relative", durationMs: max });
  });

  it("固定モードの拡大で上限を超えるときは、終了を保ち、開始を縮める", () => {
    const max = 90 * 24 * HOUR;
    const range = { mode: "absolute" as const, from: NOW - 60 * 24 * HOUR, to: NOW };
    const next = zoomRange(range, 2, NOW, max);
    expect(next).toEqual({ mode: "absolute", from: NOW - max, to: NOW });
  });
});

describe("nowRange", () => {
  it("固定モードを、幅はそのままで現在時刻の直近モードに戻す", () => {
    const range = { mode: "absolute" as const, from: NOW - 3 * HOUR, to: NOW - HOUR };
    expect(nowRange(range, NOW)).toEqual({ mode: "relative", durationMs: 2 * HOUR });
  });
});

describe("maxRangeMs", () => {
  it("SaaS は 90 日、self-hosted は上限なし", () => {
    expect(maxRangeMs(true)).toBe(90 * 24 * HOUR);
    expect(maxRangeMs(false)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("URL の相互変換", () => {
  it("直近モードはプリセットのキーで表す（例: range=1h）", () => {
    const params = toSearchParams({ mode: "relative", durationMs: HOUR });
    expect(params.get("range")).toBe("1h");
    expect(fromSearchParams(params.toString())).toEqual({ mode: "relative", durationMs: HOUR });
  });

  it("プリセットに無い幅は、分の表記で表す（例: 90m）", () => {
    const params = toSearchParams({ mode: "relative", durationMs: 90 * MINUTE });
    expect(params.get("range")).toBe("90m");
    expect(fromSearchParams(params.toString())).toEqual({
      mode: "relative",
      durationMs: 90 * MINUTE,
    });
  });

  it("固定モードは from と to を ISO 文字列で表し、同じ値に戻せる", () => {
    const range = { mode: "absolute" as const, from: NOW - HOUR, to: NOW };
    const params = toSearchParams(range);
    expect(fromSearchParams(params.toString())).toEqual(range);
  });

  it("読めない値は null（呼び出し側で既定にする）", () => {
    expect(fromSearchParams("range=abc")).toBeNull();
    expect(fromSearchParams("range=0h")).toBeNull();
    expect(fromSearchParams("from=bad&to=bad")).toBeNull();
    expect(fromSearchParams("")).toBeNull();
  });
});

describe("describeRange", () => {
  it("プリセットは、そのラベルを返す", () => {
    expect(describeRange({ mode: "relative", durationMs: HOUR })).toBe("直近 1 時間");
  });

  it("プリセットに無い直近の幅は、分で表す", () => {
    expect(describeRange({ mode: "relative", durationMs: 90 * MINUTE })).toBe("直近 90 分");
  });
});
