import { describe, expect, it } from "vitest";

import type { Sensor } from "../types";
import {
  NO_DEVICE_GROUP_ID,
  checkStateOf,
  groupByDevice,
  hasDevices,
  matchesQuery,
  worstLevel,
} from "./sensor-groups";

function sensor(id: string, name: string, device?: string): Sensor {
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
