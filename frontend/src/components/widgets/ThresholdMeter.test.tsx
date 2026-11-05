import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Sensor } from "../../types";
import { ThresholdMeter } from "./ThresholdMeter";

const base: Sensor = {
  id: "s1",
  name: "温度",
  ingestKey: "t",
  unit: "℃",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: null,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "",
  updatedAt: "",
};

describe("ThresholdMeter", () => {
  it("しきい値が無いセンサーには、何も出さない", () => {
    const { container } = render(<ThresholdMeter sensor={base} value={50} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("しきい値があれば、色の帯（正常・軽故障・重故障）と、いまの値の印を出す", () => {
    const { container } = render(<ThresholdMeter sensor={{ ...base, thresholdMaxWarning: 80, thresholdMaxCritical: 90 }} value={60} />);
    expect(container.querySelectorAll("span")).toHaveLength(3);
    const marker = container.querySelector("i") as HTMLElement;
    // 範囲は 0〜112.5（widget の自動範囲）。60 は 53.3% の位置
    expect(parseFloat(marker.style.left)).toBeCloseTo((60 / 112.5) * 100, 1);
  });

  it("値が範囲の外でも、印は端に収まる", () => {
    const { container } = render(<ThresholdMeter sensor={{ ...base, thresholdMaxCritical: 90 }} value={9999} />);
    const marker = container.querySelector("i") as HTMLElement;
    expect(parseFloat(marker.style.left)).toBeLessThanOrEqual(100);
  });
});
