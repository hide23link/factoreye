import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { render, screen } from "../test/test-utils";
import { WidgetMenu, type WidgetMenuProps } from "./WidgetMenu";

function setup(overrides: Partial<WidgetMenuProps> = {}) {
  const props: WidgetMenuProps = {
    onOpen: vi.fn(),
    onFullscreen: vi.fn(),
    onToggleTable: vi.fn(),
    tableShown: false,
    csv: "ready",
    onSaveCsv: vi.fn(),
    onCopyLink: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  render(
    <div>
      <button type="button">外側</button>
      <WidgetMenu {...props} />
    </div>,
  );
  return props;
}

const openButton = () => screen.getByRole("button", { name: "ウィジェットのメニュー" });

describe("WidgetMenu", () => {
  it("⋮ を押すと開き（onOpen を呼ぶ）、4 項目が出て、先頭にフォーカスが移る", async () => {
    const user = userEvent.setup();
    const props = setup();
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(openButton());

    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent?.replace(/[VT]$/, ""))).toEqual([
      "全画面で見る",
      "データを表で見る",
      "CSV を保存",
      "この期間のリンクをコピー",
    ]);
    expect(screen.getByRole("menuitem", { name: /全画面で見る/ })).toHaveFocus();
    expect(openButton()).toHaveAttribute("aria-expanded", "true");
  });

  it("矢印キーで選び、Enter で実行して閉じる", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(openButton());

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: /データを表で見る/ })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: /この期間のリンクをコピー/ })).toHaveFocus();
    await user.keyboard("{Home}{Enter}");

    expect(props.onFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("V・T のキーでも実行できる", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(openButton());
    await user.keyboard("t");
    expect(props.onToggleTable).toHaveBeenCalledTimes(1);
    await user.click(openButton());
    await user.keyboard("v");
    expect(props.onFullscreen).toHaveBeenCalledTimes(1);
  });

  it("Esc で閉じて、⋮ にフォーカスが戻る", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(openButton());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(openButton()).toHaveFocus();
  });

  it("外側のクリックで閉じる", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(openButton());
    await user.click(screen.getByRole("button", { name: "外側" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("データ取得中は CSV を実行できず、表を開いているときは「表を閉じる」になる", async () => {
    const user = userEvent.setup();
    const props = setup({ csv: "loading", tableShown: true });
    await user.click(openButton());
    expect(screen.getByRole("menuitem", { name: /表を閉じる/ })).toBeInTheDocument();
    const csv = screen.getByRole("menuitem", { name: /CSV を保存/ });
    expect(csv).toHaveAttribute("aria-disabled", "true");
    expect(csv).toHaveTextContent("取得中");
    await user.click(csv);
    expect(props.onSaveCsv).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("リンクのコピーでは、「コピーしました」を出す。onCopyLink が null なら項目を出さない", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(openButton());
    await user.click(screen.getByRole("menuitem", { name: /この期間のリンクをコピー/ }));
    expect(props.onCopyLink).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("コピーしました")).toBeInTheDocument();
  });

  it("リンクで開けない種類では、リンクの項目を出さない", async () => {
    const user = userEvent.setup();
    setup({ onCopyLink: null });
    await user.click(openButton());
    expect(screen.queryByRole("menuitem", { name: /リンク/ })).toBeNull();
  });
});
