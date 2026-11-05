import { describe, expect, it } from "vitest";

import type { Sensor } from "../types";
import {
  NO_DEVICE_GROUP_ID,
  NO_LINE_GROUP_ID,
  checkStateOf,
  countByWord,
  groupByDevice,
  groupByLine,
  hasDevices,
  hasLines,
  matchesQuery,
  matchesWord,
  worstLevel,
} from "./sensor-groups";

function sensor(id: string, name: string, device?: string, line?: string): Sensor {
  return {
    id,
    name,
    ingestKey: `key-${id}`,
    unit: "V",
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: null,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    deviceId: device ? `dev-${device}` : null,
    deviceName: device ?? null,
    deviceLine: line ?? null,
  };
}

describe("groupByDevice", () => {
  it("機器の名前順（数字は大きさで比べる）に並べ、「未所属」は最後にする", () => {
    const groups = groupByDevice([
      sensor("a", "A", "r-10"),
      sensor("b", "B"),
      sensor("c", "C", "r-2"),
      sensor("d", "D", "r-10"),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["r-2", "r-10", "未所属"]);
    expect(groups[2].id).toBe(NO_DEVICE_GROUP_ID);
    // センサーの順番は渡した順のまま
    expect(groups[1].sensors.map((s) => s.id)).toEqual(["a", "d"]);
  });

  it("古い API（機器の項目が無い）のセンサーは、すべて未所属になる", () => {
    const legacy = { ...sensor("x", "X"), deviceId: undefined, deviceName: undefined };
    expect(groupByDevice([legacy]).map((g) => g.id)).toEqual([NO_DEVICE_GROUP_ID]);
    expect(hasDevices([legacy])).toBe(false);
  });
});

describe("matchesQuery", () => {
  it("名前・ingestKey・機器名のどれでも当たる（大文字小文字は区別しない）", () => {
    const s = sensor("1", "負荷試験 電圧", "R-Load-01");
    expect(matchesQuery(s, "電圧")).toBe(true);
    expect(matchesQuery(s, "key-1")).toBe(true);
    expect(matchesQuery(s, "r-load-01")).toBe(true);
    expect(matchesQuery(s, "電流")).toBe(false);
    expect(matchesQuery(s, "")).toBe(true);
  });
});

describe("worstLevel と checkStateOf", () => {
  const list = [sensor("1", "a"), sensor("2", "b"), sensor("3", "c")];

  it("重いアラームを優先する。無ければ none", () => {
    expect(worstLevel(list, new Map())).toBe("none");
    expect(worstLevel(list, new Map([["2", "warning"]]))).toBe("warning");
    expect(
      worstLevel(
        list,
        new Map([
          ["1", "warning"],
          ["3", "critical"],
        ]),
      ),
    ).toBe("critical");
  });

  it("選択の状態: 全部 / 一部 / なし", () => {
    expect(checkStateOf(list, new Set())).toBe("none");
    expect(checkStateOf(list, new Set(["1"]))).toBe("some");
    expect(checkStateOf(list, new Set(["1", "2", "3"]))).toBe("all");
  });
});

describe("matchesWord と countByWord", () => {
  const list = [sensor("1", "ld01 電圧", "r-1"), sensor("2", "ld01 電流", "r-1"), sensor("3", "Temp A"), sensor("4", "ld02 電圧")];

  it("名前に語を含むものに合う（大文字小文字は区別しない）。null なら全部合う", () => {
    expect(matchesWord(list[0], "電圧")).toBe(true);
    expect(matchesWord(list[1], "電圧")).toBe(false);
    expect(matchesWord(list[2], "temp")).toBe(true);
    expect(matchesWord(list[1], null)).toBe(true);
  });

  it("機器名やキーには当たらない（センサー名だけを見る）", () => {
    expect(matchesWord(list[0], "r-1")).toBe(false);
    expect(matchesWord(list[0], "key-1")).toBe(false);
  });

  it("語ごとの件数を、渡したセンサー全体で数える", () => {
    const counts = countByWord(list, ["電圧", "電流", "電位", "temp"]);
    expect([...counts]).toEqual([
      ["電圧", 2],
      ["電流", 1],
      ["電位", 0],
      ["temp", 1],
    ]);
  });
});

describe("groupByLine（系統 › 機器）", () => {
  const list = [
    sensor("a", "A", "r-1", "第10ライン"),
    sensor("b", "B", "r-2", "第2ライン"),
    sensor("c", "C", "r-3"), // 系統のない機器
    sensor("d", "D"), // 機器に所属しない
    sensor("e", "E", "r-4", "第2ライン"),
  ];

  it("系統の名前順（数字は大きさで比べる）に並べ、「系統なし」は最後。中は機器ごと", () => {
    const lines = groupByLine(list);
    expect(lines.map((l) => l.name)).toEqual(["第2ライン", "第10ライン", "系統なし"]);
    expect(lines[0].devices.map((d) => d.name)).toEqual(["r-2", "r-4"]);
    expect(lines[0].sensors.map((s) => s.id)).toEqual(["b", "e"]);
  });

  it("系統のない機器と、機器に所属しないセンサー（未所属）は、「系統なし」に入る", () => {
    const noLine = groupByLine(list).at(-1);
    expect(noLine?.id).toBe(NO_LINE_GROUP_ID);
    expect(noLine?.devices.map((d) => d.name)).toEqual(["r-3", "未所属"]);
    expect(noLine?.sensors.map((s) => s.id)).toEqual(["c", "d"]);
  });

  it("利用者が「系統なし」という名前の系統を付けても、本物の「系統なし」と混ざらない", () => {
    const lines = groupByLine([sensor("x", "X", "r-1", "系統なし"), sensor("y", "Y", "r-2")]);
    expect(lines.map((l) => l.id)).toEqual(["line:系統なし", NO_LINE_GROUP_ID]);
  });

  it("系統が 1 つも無ければ hasLines は false。1 つでもあれば true", () => {
    expect(hasLines([sensor("a", "A", "r-1"), sensor("b", "B")])).toBe(false);
    expect(hasLines(list)).toBe(true);
  });

  it("検索は系統名にも当たる", () => {
    expect(matchesQuery(list[0], "第10ライン".toLowerCase())).toBe(true);
    expect(matchesQuery(list[2], "第10ライン")).toBe(false);
  });
});
