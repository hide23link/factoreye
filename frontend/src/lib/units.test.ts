import { describe, expect, it } from "vitest";
import { normalizeUnit, unitForServer } from "./units";

describe("normalizeUnit（単位が「-」のセンサーに、名前から単位を補う）", () => {
  it("単位が入っていれば、そのまま使う", () => {
    expect(normalizeUnit("ppm", "洋室 CO2", "co2")).toBe("ppm");
    expect(normalizeUnit("°C", "atom01-temp", "atom01-temp")).toBe("°C");
  });

  it.each([
    ["atom01-temp", "°C"],
    ["atom01-humi", "%"],
    ["atom01-press", "hPa"],
    ["atom02-rssi", "dBm"],
    ["atom01-uptime", "s"],
    ["atom01-sendfail", "回"],
    ["atom01-wifidc", "回"],
    ["atom01-reset", "回"],
    ["リビング 温度", "°C"],
  ])("単位が「-」なら、名前 %s から %s を補う", (name, unit) => {
    expect(normalizeUnit("-", name, name)).toBe(unit);
  });

  it("名前から決められなければ空（数字だけ出す）。空の単位も同じ", () => {
    expect(normalizeUnit("-", "atom01-heartbeat", "atom01-heartbeat")).toBe("");
    expect(normalizeUnit("", "不明", "x")).toBe("");
  });
});

describe("unitForServer（サーバーへ送る単位）", () => {
  it("空は仮の単位「-」にする（サーバーは 1 文字以上が必須）", () => {
    expect(unitForServer("")).toBe("-");
    expect(unitForServer("  ")).toBe("-");
    expect(unitForServer(" ppm ")).toBe("ppm");
  });
});
