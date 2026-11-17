import { describe, expect, it } from "vitest";

import { render, screen } from "../../test/test-utils";
import { GraphValues } from "./GraphValues";

describe("GraphValues（グラフの右の今の値）", () => {
  it("線ごとに、今の値と単位を出す。受信が無ければ「---」", () => {
    render(
      <GraphValues
        items={[
          { name: "洋室 CO2", color: "#2563eb", unit: "ppm", value: 1050 },
          { name: "寝室 CO2", color: "#ea580c", unit: "ppm", value: undefined },
        ]}
      />,
    );
    expect(screen.getByText("1050")).toBeInTheDocument();
    expect(screen.getByText("---")).toBeInTheDocument();
    // 複数のときは、どの線の値か分かるよう名前も出す
    expect(screen.getByText("洋室 CO2")).toBeInTheDocument();
  });

  it("小数の桁（decimals）を指定すれば、その桁で出す。1 本のときは名前を出さない", () => {
    render(<GraphValues items={[{ name: "温度", color: "#2563eb", unit: "℃", value: 22.44 }]} decimals={1} />);
    expect(screen.getByText("22.4")).toBeInTheDocument();
    expect(screen.queryByText("温度")).not.toBeInTheDocument();
  });
});
