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
    // 複数のときは、どの線の値か分かるよう、札の下に名前と単位も出す
    expect(screen.getByText("洋室 CO2 ppm")).toBeInTheDocument();
  });

  it("小数の桁（decimals）を指定すれば、その桁で出す。1 本のときは名前を出さない", () => {
    render(<GraphValues items={[{ name: "温度", color: "#2563eb", unit: "℃", value: 22.44 }]} decimals={1} />);
    expect(screen.getByText("22.4")).toBeInTheDocument();
    expect(screen.queryByText("温度")).not.toBeInTheDocument();
    expect(screen.getByText("℃")).toBeInTheDocument();
  });

  it("グラフの中で高さを測れたら、札を線の最後の点の高さに置き、左の矢印でその点を指す", () => {
    render(
      <GraphValues
        items={[
          { name: "洋室", color: "#2563eb", unit: "dBm", value: -62 },
          { name: "寝室", color: "#ea580c", unit: "dBm", value: -63 },
          { name: "和室", color: "#16a34a", unit: "dBm", value: undefined },
        ]}
        measure={{ height: 300, ys: [100, 104, undefined] }}
      />,
    );
    const tagOf = (text: string) => screen.getByText(text).closest("li") as HTMLElement;
    // 1 つ目は数字の枠の真ん中が 100 px（上端 90）。2 つ目は重ならないよう、そのすぐ下へずらす
    expect(tagOf("-62")).toHaveStyle({ top: "90px" });
    expect(tagOf("-63")).toHaveStyle({ top: "124px" });
    // 矢印は線の色で、ずらした札でも元の高さ（104 px）を指す。高さの分からない線には矢印を出さない
    const arrows = screen.getAllByTestId("graph-value-arrow");
    expect(arrows).toHaveLength(2);
    expect(arrows[1].querySelector("polygon")).toHaveAttribute("points", expect.stringMatching(/^0,-20 /));
    expect(arrows[1].querySelector("polygon")).toHaveAttribute("fill", "#ea580c");
  });
});
