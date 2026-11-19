import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LegendTable, type LegendTableItem } from "./LegendTable";

const items: LegendTableItem[] = [
  { sensorId: "a", name: "温度", color: "#ff0000", unit: "°C", value: 21.5, stats: { min: 20, max: 25, average: 22.5 } },
  { sensorId: "b", name: "湿度", color: "#00ff00", unit: "%", value: undefined, stats: undefined },
];

describe("LegendTable", () => {
  it("名前・値・最小・最大・平均を出し、値が無ければ --- を出す", () => {
    render(<LegendTable items={items} selected={[]} onToggle={() => {}} atCursor={false} />);
    expect(screen.getByText("値（最新）")).toBeInTheDocument();
    expect(screen.getByText("21.5")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("22.5")).toBeInTheDocument();
    expect(screen.getAllByText("---").length).toBe(4);
  });

  it("カーソルがあるときは見出しが変わる", () => {
    render(<LegendTable items={items} selected={[]} onToggle={() => {}} atCursor />);
    expect(screen.getByText("値（カーソル）")).toBeInTheDocument();
  });

  it("色の見本は設定した色と一致する", () => {
    render(<LegendTable items={items} selected={[]} onToggle={() => {}} atCursor={false} />);
    const swatches = screen.getAllByTestId("legend-swatch");
    expect(swatches[0]).toHaveStyle({ background: "rgb(255, 0, 0)" });
    expect(swatches[1]).toHaveStyle({ background: "rgb(0, 255, 0)" });
  });

  it("行のクリックと Enter・Space で切り替わり、Shift クリックは複数選択になる", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<LegendTable items={items} selected={[]} onToggle={onToggle} atCursor={false} />);
    await user.click(screen.getByText("21.5"));
    expect(onToggle).toHaveBeenLastCalledWith("a", false);
    screen.getByRole("button", { name: "湿度 だけ表示する" }).focus();
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenLastCalledWith("b", false);
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(3);
    await user.keyboard("{Shift>}");
    await user.click(screen.getByText("温度"));
    expect(onToggle).toHaveBeenLastCalledWith("a", true);
  });

  it("aria-pressed は選ばれた行だけ true", () => {
    render(<LegendTable items={items} selected={["a"]} onToggle={() => {}} atCursor={false} />);
    expect(screen.getByRole("button", { name: "温度 だけ表示する" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "湿度 だけ表示する" })).toHaveAttribute("aria-pressed", "false");
  });
});
