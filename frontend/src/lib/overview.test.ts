import { describe, expect, it } from "vitest";

import type { Alarm, Reading, Sensor } from "../types";
import {
  buildStrips,
  countDevicesAndSensors,
  countStates,
  formatAge,
  formatChange,
  formatSensorNumber,
  formatSensorValue,
  formatShortAge,
  kindOfUnit,
  kindsOf,
  pickKindValue,
  STALE_MS,
} from "./overview";

const NOW = new Date("2026-11-18T00:42:00Z").getTime();

function sensor(id: string, name: string, extra: Partial<Sensor> = {}): Sensor {
  return {
    id,
    name,
    ingestKey: id,
    unit: "℃",
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: null,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

const reading = (sensorId: string, value: number, agoMs = 10_000): Reading => ({
  sensorId,
  value,
  recordedAt: new Date(NOW - agoMs).toISOString(),
});

function alarm(sensorId: string, severity: Alarm["severity"], status: Alarm["status"] = "active"): Alarm {
  return {
    id: `${sensorId}-${severity}`,
    sensorId,
    triggeredAt: new Date(NOW).toISOString(),
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    value: 1,
    status,
    thresholdBreached: "max",
    severity,
  };
}

describe("buildStrips（全体監視の札）", () => {
  it("同じ機器のセンサーは 1 枚の札にまとめ、機器の無いセンサーは 1 つずつ", () => {
    const sensors = [
      sensor("t", "洋室 温度", { deviceId: "d1", deviceName: "env-youshitsu" }),
      sensor("h", "洋室 湿度", { deviceId: "d1", deviceName: "env-youshitsu" }),
      sensor("x", "単独"),
    ];
    const strips = buildStrips(sensors, [reading("t", 20), reading("h", 50), reading("x", 1)], [], NOW);
    expect(strips.map((s) => s.title).sort()).toEqual(["env-youshitsu", "単独"]);
    expect(strips.find((s) => s.title === "env-youshitsu")?.sensors).toHaveLength(2);
  });

  it("状態の重い順（警報 → 注意 → 正常 → 未受信）に並べる", () => {
    const sensors = [
      sensor("ok", "正常"),
      sensor("never", "まだ"),
      sensor("hot", "高い", { thresholdMaxCritical: 100 }),
      sensor("old", "止まった"),
    ];
    const latest = [reading("ok", 1), reading("hot", 120), reading("old", 1, STALE_MS + 1)];
    const strips = buildStrips(sensors, latest, [], NOW);
    expect(strips.map((s) => s.state)).toEqual(["critical", "warning", "normal", "never"]);
    expect(strips[1].reason).toBe("受信なし");
  });

  it("未解決のアラームがあれば、値が戻っていてもその重さ。解決済みは数えない", () => {
    const sensors = [sensor("a", "A"), sensor("b", "B")];
    const strips = buildStrips(sensors, [reading("a", 1), reading("b", 1)], [alarm("a", "warning"), alarm("b", "critical", "resolved")], NOW);
    expect(strips.find((s) => s.title === "A")?.state).toBe("warning");
    expect(strips.find((s) => s.title === "B")?.state).toBe("normal");
  });

  it("状態ごとの数", () => {
    const strips = buildStrips([sensor("a", "A"), sensor("b", "B")], [reading("a", 1)], [], NOW);
    expect(countStates(strips)).toEqual({ critical: 0, warning: 0, normal: 1, never: 1 });
  });
});

describe("buildStrips の受信なし・無効", () => {
  it("機器の中の 1 センサーだけ止まっても、注意（そのセンサー名 受信なし）", () => {
    const sensors = [
      sensor("t", "温度", { deviceId: "d", deviceName: "env" }),
      sensor("h", "湿度", { deviceId: "d", deviceName: "env" }),
    ];
    const strips = buildStrips(sensors, [reading("t", 20), reading("h", 50, STALE_MS + 60_000)], [], NOW);
    expect(strips[0].state).toBe("warning");
    expect(strips[0].reason).toBe("湿度 受信なし");
  });

  it("15 分ちょうどまでは正常、超えたら受信なし", () => {
    expect(buildStrips([sensor("a", "A")], [reading("a", 1, STALE_MS)], [], NOW)[0].state).toBe("normal");
    expect(buildStrips([sensor("a", "A")], [reading("a", 1, STALE_MS + 1000)], [], NOW)[0].state).toBe("warning");
  });

  it("無効にしたセンサーは札に入れない", () => {
    expect(buildStrips([sensor("a", "A", { enabled: false })], [reading("a", 1)], [], NOW)).toEqual([]);
  });
});

describe("formatAge", () => {
  it("秒・分・時間・日", () => {
    expect(formatAge(12_000)).toBe("12 秒前");
    expect(formatAge(5 * 60_000)).toBe("5 分前");
    expect(formatAge(3 * 3_600_000)).toBe("3 時間前");
    expect(formatAge(3 * 86_400_000)).toBe("3 日前");
  });
});

describe("formatShortAge（等幅向けの短い経過時間）", () => {
  it("60 秒未満は秒、60 分未満は分、48 時間未満は時間、それ以上は日", () => {
    expect(formatShortAge(12_000)).toBe("12s");
    expect(formatShortAge(5 * 60_000)).toBe("5m");
    expect(formatShortAge(3 * 3_600_000)).toBe("3h");
    expect(formatShortAge(3 * 86_400_000)).toBe("3d");
  });
});

describe("値の桁（単位で決める）", () => {
  it("℃ と hPa は 1 桁、% と ppm は 0 桁、ほかは有効数字 4 桁", () => {
    expect(formatSensorValue(22.4321, "℃")).toBe("22.4℃");
    expect(formatSensorValue(49.84, "%")).toBe("50%");
    expect(formatSensorValue(1050.4, "ppm")).toBe("1050ppm");
    expect(formatSensorValue(1012.44, "hPa")).toBe("1012.4hPa");
    expect(formatSensorNumber(3.14159265, "mm/s")).toBe("3.142");
  });
  it("1 時間の変化は、増えれば ↑、減れば ↓。丸めて 0 なら矢印なし", () => {
    expect(formatChange(0.64, "℃")).toBe("↑0.6");
    expect(formatChange(-0.24, "℃")).toBe("↓0.2");
    expect(formatChange(0.02, "℃")).toBe("0.0");
  });
});

describe("種類の切り替え", () => {
  it("単位から種類を決め、温度・湿度・CO2・気圧の順に並べる（無効なセンサーは除く）", () => {
    expect(kindOfUnit("ppm")).toBe("CO2");
    expect(kindOfUnit("mm/s")).toBe("mm/s");
    const sensors = [
      sensor("a", "A", { unit: "ppm" }),
      sensor("b", "B", { unit: "℃" }),
      sensor("c", "C", { unit: "個" }),
      sensor("d", "D", { unit: "%", enabled: false }),
    ];
    expect(kindsOf(sensors)).toEqual(["温度", "CO2", "個"]);
  });
  it("札の中の選んだ種類の値と、1 時間前からの変化を取り出す。無ければ null", () => {
    const sensors = [sensor("t", "温度", { unit: "℃", deviceId: "d", deviceName: "env" }), sensor("c", "CO2", { unit: "ppm", deviceId: "d", deviceName: "env" })];
    const [strip] = buildStrips(sensors, [reading("t", 22.4), reading("c", 650)], [], NOW);
    expect(pickKindValue(strip, "温度", new Map([["t", 21.8]]))).toEqual({ text: "22.4℃", change: "↑0.6" });
    expect(pickKindValue(strip, "CO2", new Map())).toEqual({ text: "650ppm", change: null });
    expect(pickKindValue(strip, "湿度", new Map())).toBeNull();
  });
});

describe("countDevicesAndSensors（上の帯の「機器 N · センサー M」）", () => {
  it("同じ機器は 1 台、機器の無いセンサーは 1 つずつ。無効なセンサーは数えない", () => {
    const sensors = [
      sensor("a", "A", { deviceId: "d1" }),
      sensor("b", "B", { deviceId: "d1" }),
      sensor("c", "C"),
      sensor("d", "D", { enabled: false }),
    ];
    expect(countDevicesAndSensors(sensors)).toEqual({ devices: 2, sensors: 3 });
  });
});
