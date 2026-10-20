import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { UNIT_PRESETS } from "../lib/units";
import { render, screen } from "../test/test-utils";
import { UnitSelect } from "./UnitSelect";

function Harness({ initial }: { initial: string }) {
  const [unit, setUnit] = useState(initial);
  return (
    <>
      <UnitSelect value={unit} onChange={setUnit} />
      <output data-testid="value">{unit}</output>
    </>
  );
}

describe("UnitSelect", () => {
  it("初期値が °C でも、すべての候補から選べる（絞り込まれない）", () => {
    render(<Harness initial="°C" />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    for (const preset of UNIT_PRESETS) expect(options.some((t) => t?.startsWith(preset.value))).toBe(true);
    expect(options).toContain("その他（自由入力）");
    expect(UNIT_PRESETS.map((p) => p.value)).toEqual(expect.arrayContaining(["°C", "MPa", "kW", "A", "V", "%", "rpm", "個", "台", "本", "回", "kWh"]));
  });

  it("候補を選ぶと、その単位になる", async () => {
    const user = userEvent.setup();
    render(<Harness initial="°C" />);
    await user.selectOptions(screen.getByRole("combobox", { name: "単位" }), "MPa");
    expect(screen.getByTestId("value")).toHaveTextContent("MPa");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("「その他」を選ぶと入力欄が出て、自由に入力できる", async () => {
    const user = userEvent.setup();
    render(<Harness initial="°C" />);
    await user.selectOptions(screen.getByRole("combobox", { name: "単位" }), "その他（自由入力）");
    await user.type(screen.getByRole("textbox", { name: "単位（自由入力）" }), "ppm");
    expect(screen.getByTestId("value")).toHaveTextContent("ppm");
  });

  it("候補にない既存の単位は、「その他」の入力欄にそのまま表示される", () => {
    render(<Harness initial="ppm" />);
    expect(screen.getByRole("combobox", { name: "単位" })).toHaveValue("__other__");
    expect(screen.getByRole("textbox", { name: "単位（自由入力）" })).toHaveValue("ppm");
  });

  it("「その他」から候補に戻せる", async () => {
    const user = userEvent.setup();
    render(<Harness initial="ppm" />);
    await user.selectOptions(screen.getByRole("combobox", { name: "単位" }), "kW");
    expect(screen.getByTestId("value")).toHaveTextContent("kW");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
