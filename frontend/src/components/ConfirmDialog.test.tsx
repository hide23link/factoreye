import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { render, screen } from "../test/test-utils";
import { ConfirmDialog } from "./ConfirmDialog";

function Harness({ onConfirm = () => {} }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        開く
      </button>
      {open && (
        <ConfirmDialog
          title="削除の確認"
          message="削除しますか？"
          onConfirm={onConfirm}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe("ConfirmDialog", () => {
  it("dialog の属性を持ち、開くと「キャンセル」にフォーカスする", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "開く" }));

    const dialog = screen.getByRole("dialog", { name: "削除の確認" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "キャンセル" })).toHaveFocus();
  });

  it("Esc でキャンセルし、フォーカスを元のボタンへ戻す", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "開く" });
    await user.click(opener);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("Tab は小窓の中で循環し、背景のボタンへ抜けない", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "開く" }));

    const cancel = screen.getByRole("button", { name: "キャンセル" });
    const confirm = screen.getByRole("button", { name: "削除" });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it("背景をクリックしても閉じず、pending 中は確認ボタンを押せない", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} pending />,
    );

    await user.click(screen.getByRole("dialog").parentElement!);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "削除" })).toBeDisabled();
  });
});
