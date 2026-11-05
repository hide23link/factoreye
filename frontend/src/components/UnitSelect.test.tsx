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
    await user.type(screen.getByRole("textbox", { name: "単位（自由入力）" }), "psi");
    expect(screen.getByTestId("value")).toHaveTextContent("psi");
  });

  it("候補にない既存の単位は、「その他」の入力欄にそのまま表示される", () => {
    render(<Harness initial="psi" />);
    expect(screen.getByRole("combobox", { name: "単位" })).toHaveValue("__other__");
    expect(screen.getByRole("textbox", { name: "単位（自由入力）" })).toHaveValue("psi");
  });

  it("「その他」から候補に戻せる", async () => {
    const user = userEvent.setup();
    render(<Harness initial="psi" />);
    await user.selectOptions(screen.getByRole("combobox", { name: "単位" }), "kW");
    expect(screen.getByTestId("value")).toHaveTextContent("kW");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("「その他」で入力したあと、親が単位を初期値（候補）に戻したら、選択欄も初期状態に戻る（作成後の再入力）", async () => {
    const user = userEvent.setup();
    function Form() {
      const [unit, setUnit] = useState("°C");
      return (
        <>
          <UnitSelect value={unit} onChange={setUnit} />
          <button type="button" onClick={() => setUnit("°C")}>
            リセット
          </button>
        </>
      );
    }
    render(<Form />);
    await user.selectOptions(screen.getByRole("combobox", { name: "単位" }), "その他（自由入力）");
    await user.type(screen.getByRole("textbox", { name: "単位（自由入力）" }), "psi");

    await user.click(screen.getByRole("button", { name: "リセット" }));

    expect(screen.getByRole("combobox", { name: "単位" })).toHaveValue("°C");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("「その他」で 1 文字ずつ入力して、途中で候補と一致しても（L → L/h）、入力欄が消えない", async () => {
    const user = userEvent.setup();
    render(<Harness initial="°C" />);
    await user.selectOptions(screen.getByRole("combobox", { name: "単位" }), "その他（自由入力）");
    const input = screen.getByRole("textbox", { name: "単位（自由入力）" });

    await user.type(input, "L"); // 「L」は候補と一致する
    expect(screen.getByRole("textbox", { name: "単位（自由入力）" })).toHaveFocus();
    await user.type(screen.getByRole("textbox", { name: "単位（自由入力）" }), "/h");

    expect(screen.getByRole("textbox", { name: "単位（自由入力）" })).toHaveValue("L/h");
    expect(screen.getByTestId("value")).toHaveTextContent("L/h");
    for (const text of ["mm/h", "Pa·s", "A/m"]) {
      await user.clear(screen.getByRole("textbox", { name: "単位（自由入力）" }));
      await user.type(screen.getByRole("textbox", { name: "単位（自由入力）" }), text);
      expect(screen.getByRole("textbox", { name: "単位（自由入力）" })).toHaveValue(text);
    }
  });
});
