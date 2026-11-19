import { afterEach, describe, expect, it, vi } from "vitest";

import { addSeen, findNewSensorIds, readSeenSensorIds, seenKey, splitForAdd, writeSeenSensorIds } from "./new-sensors";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("findNewSensorIds（まだ見ていないセンサー）", () => {
  it("見ていないものだけを、一覧の順で返す", () => {
    expect(findNewSensorIds(["a", "b", "c"], new Set(["a"]), [])).toEqual(["b", "c"]);
  });
  it("初回（記録が無い）は、通知しない", () => expect(findNewSensorIds(["a", "b"], null, [])).toEqual([]));
  it("通知待ちに入っているものは、2 回数えない", () => {
    expect(findNewSensorIds(["a", "b", "c"], new Set(["a"]), ["b"])).toEqual(["c"]);
  });
  it("全部見ていれば空", () => expect(findNewSensorIds(["a"], new Set(["a"]), [])).toEqual([]));
});

describe("addSeen", () => {
  it("足した新しい集合を返し、元は変えない", () => {
    const before = new Set(["a"]);
    expect([...addSeen(before, ["b"])].sort()).toEqual(["a", "b"]);
    expect(before.size).toBe(1);
  });
  it("null からでも作れる", () => expect([...addSeen(null, ["x"])]).toEqual(["x"]));
});

describe("splitForAdd（8 件まで）", () => {
  it("上限までを head、残りを rest に分ける", () => {
    expect(splitForAdd(["a", "b", "c"], 2)).toEqual({ head: ["a", "b"], rest: ["c"] });
    expect(splitForAdd(["a"], 2)).toEqual({ head: ["a"], rest: [] });
    expect(splitForAdd(Array.from({ length: 9 }, (_, i) => String(i))).rest).toEqual(["8"]);
  });
});

describe("見たセンサーの記録", () => {
  it("利用者（ワークスペース）ごとに別の記録", () => {
    writeSeenSensorIds("w1", ["a"]);
    expect(readSeenSensorIds("w2")).toBeNull();
    expect([...(readSeenSensorIds("w1") ?? [])]).toEqual(["a"]);
  });
  it("書いた集合を読める。無ければ null（初回）", () => {
    expect(readSeenSensorIds("w1")).toBeNull();
    writeSeenSensorIds("w1", ["a", "b"]);
    expect([...(readSeenSensorIds("w1") ?? [])].sort()).toEqual(["a", "b"]);
  });
  it("壊れた記録は null（初回）として扱う", () => {
    window.localStorage.setItem(seenKey("w1"), "{oops");
    expect(readSeenSensorIds("w1")).toBeNull();
    window.localStorage.setItem(seenKey("w1"), '{"a":1}');
    expect(readSeenSensorIds("w1")).toBeNull();
  });
  it("localStorage が使えなくても、例外にしない", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSeenSensorIds("w1")).toBeNull();
    expect(() => writeSeenSensorIds("w1", ["a"])).not.toThrow();
  });
});
