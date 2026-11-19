import { afterEach, describe, expect, it, vi } from "vitest";

import { addSeen, findNewSensorIds, readSeenSensorIds, writeSeenSensorIds } from "./new-sensors";

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

describe("見たセンサーの記録", () => {
  it("書いた集合を読める。無ければ null（初回）", () => {
    expect(readSeenSensorIds()).toBeNull();
    writeSeenSensorIds(["a", "b"]);
    expect([...(readSeenSensorIds() ?? [])].sort()).toEqual(["a", "b"]);
  });
  it("壊れた記録は null（初回）として扱う", () => {
    window.localStorage.setItem("factoreye.seenSensorIds", "{oops");
    expect(readSeenSensorIds()).toBeNull();
    window.localStorage.setItem("factoreye.seenSensorIds", '{"a":1}');
    expect(readSeenSensorIds()).toBeNull();
  });
  it("localStorage が使えなくても、例外にしない", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSeenSensorIds()).toBeNull();
    expect(() => writeSeenSensorIds(["a"])).not.toThrow();
  });
});
