import { describe, expect, it } from "vitest";

import { validateSensorBasics, validateThresholds } from "./sensor-validation";

describe("validateSensorBasics", () => {
  it("名前・単位・キーが空ならそれぞれ理由を返す", () => {
    expect(validateSensorBasics({ name: " ", unit: "℃" })).toContain("名前");
    expect(validateSensorBasics({ name: "a", unit: "", ingestKey: "k" })).toContain("単位");
    expect(validateSensorBasics({ name: "a", unit: "℃", ingestKey: " " })).toContain("Ingest Key");
  });
  it("そろっていれば null", () => {
    expect(validateSensorBasics({ name: "a", unit: "℃", ingestKey: "k" })).toBeNull();
    expect(validateSensorBasics({ name: "a", unit: "℃" })).toBeNull();
  });
});

describe("validateThresholds", () => {
  const none = { minCritical: null, minWarning: null, maxWarning: null, maxCritical: null };
  it("何も設定しなければ問題なし。上限だけ・下限だけも問題なし", () => {
    expect(validateThresholds(none)).toBeNull();
    expect(validateThresholds({ ...none, maxWarning: 10, maxCritical: 20 })).toBeNull();
    expect(validateThresholds({ ...none, minCritical: 0, minWarning: 5 })).toBeNull();
  });
  it("正しい並び（同じ値も可）", () => {
    expect(validateThresholds({ minCritical: 0, minWarning: 5, maxWarning: 50, maxCritical: 50 })).toBeNull();
  });
  it("軽故障の下限が上限より大きいと、理由を返す", () => {
    expect(validateThresholds({ ...none, minWarning: 30, maxWarning: 10 })).toContain("大小");
  });
  it("重故障が軽故障より内側だと、理由を返す", () => {
    expect(validateThresholds({ ...none, maxWarning: 100, maxCritical: 90 })).toContain("大小");
    expect(validateThresholds({ ...none, minWarning: 10, minCritical: 20 })).toContain("大小");
  });
  it("間が空いていても、設定した項目どうしで比べる", () => {
    expect(validateThresholds({ ...none, minCritical: 50, maxCritical: 40 })).toContain("大小");
  });
});
