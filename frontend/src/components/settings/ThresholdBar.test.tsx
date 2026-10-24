import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Sensor } from "../../types";
import { ThresholdBar } from "./ThresholdBar";

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

describe("ThresholdBar", () => {
  it("しきい値が無ければ「しきい値なし」", () => {
    render(<ThresholdBar sensor={base} />);
    expect(screen.getByText("しきい値なし")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("帯の範囲を、読み上げ用の文にする（上限のみ: 正常 〜80、軽故障 80〜90、重故障 90〜）", () => {
    render(<ThresholdBar sensor={{ ...base, thresholdMaxWarning: 80, thresholdMaxCritical: 90 }} />);
    expect(screen.getByRole("img", { name: "しきい値: 正常 〜80、軽故障 80〜90、重故障 90〜" })).toBeInTheDocument();
  });

  it("下限もあるときは、両端が重故障になる。帯の幅は割合で指定される", () => {
    render(
      <ThresholdBar
        sensor={{ ...base, thresholdMinCritical: 0, thresholdMinWarning: 10, thresholdMaxWarning: 90, thresholdMaxCritical: 100 }}
      />,
    );
    const bar = screen.getByRole("img", { name: /^しきい値: 重故障 〜0、軽故障 0〜10、正常 10〜90、軽故障 90〜100、重故障 100〜$/ });
    const widths = Array.from(bar.children).map((c) => parseFloat((c as HTMLElement).style.width));
    expect(widths).toHaveLength(5);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });
});
