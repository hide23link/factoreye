import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApiError } from "../../lib/adminApi";
import { renderWithQueryClient as render, screen, waitFor } from "../../test/test-utils";
import { AdminResetDialog } from "./AdminResetDialog";

vi.mock("../../lib/adminApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/adminApi")>()),
  resetAdminUser: vi.fn(),
}));

import * as adminApi from "../../lib/adminApi";

afterEach(() => vi.resetAllMocks());

function setup() {
  const props = { onClose: vi.fn(), onDone: vi.fn(), onAuthError: vi.fn() };
  render(<AdminResetDialog token="t" userId="u1" email="tanaka@example.com" {...props} />);
  return props;
}

describe("AdminResetDialog（管理者のリセット）", () => {
  it("実行すると何が起きるかを見せ、パスキーの削除は既定でオン", () => {
    setup();

    expect(screen.getByText("tanaka@example.com をリセットしますか？")).toBeInTheDocument();
    expect(screen.getByText(/全端末のログインを終了します/)).toBeInTheDocument();
    expect(screen.getByText(/再登録リンク（1 時間有効）/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /登録済みのパスキーも削除する/ })).toBeChecked();
  });

  it("実行すると、パスキー削除ありで API を呼び、結果を出す", async () => {
    vi.mocked(adminApi.resetAdminUser).mockResolvedValue({ emailSent: true });
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByRole("button", { name: "リセットを実行" }));

    await waitFor(() => expect(adminApi.resetAdminUser).toHaveBeenCalledWith("t", "u1", true));
    expect(await screen.findByRole("status")).toHaveTextContent("tanaka@example.com へ再登録リンクを送り、全端末のログインを終了しました");
    expect(props.onDone).toHaveBeenCalled();
  });

  it("パスキーを残す選択もできる", async () => {
    vi.mocked(adminApi.resetAdminUser).mockResolvedValue({ emailSent: true });
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("checkbox", { name: /登録済みのパスキーも削除する/ }));
    await user.click(screen.getByRole("button", { name: "リセットを実行" }));

    await waitFor(() => expect(adminApi.resetAdminUser).toHaveBeenCalledWith("t", "u1", false));
  });

  it("やめるを押すと、実行せずに閉じる", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByRole("button", { name: "やめる" }));

    expect(props.onClose).toHaveBeenCalled();
    expect(adminApi.resetAdminUser).not.toHaveBeenCalled();
  });

  it("メールを送れない（503）・送信の失敗（502）・回数の制限（429）のときは、分かる文言を出す", async () => {
    vi.mocked(adminApi.resetAdminUser).mockRejectedValueOnce(new AdminApiError(503, "x"));
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "リセットを実行" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("何も変更していません");

    vi.mocked(adminApi.resetAdminUser).mockRejectedValueOnce(new AdminApiError(502, "x"));
    await user.click(screen.getByRole("button", { name: "リセットを実行" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("パスキーも消していません"));

    vi.mocked(adminApi.resetAdminUser).mockRejectedValueOnce(new AdminApiError(429, "x"));
    await user.click(screen.getByRole("button", { name: "リセットを実行" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("リセットを行いすぎました"));
  });

  it("管理者トークンが失効（401）していたら、ログインし直させる", async () => {
    vi.mocked(adminApi.resetAdminUser).mockRejectedValue(new AdminApiError(401, "x"));
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByRole("button", { name: "リセットを実行" }));

    await waitFor(() => expect(props.onAuthError).toHaveBeenCalled());
  });
});
