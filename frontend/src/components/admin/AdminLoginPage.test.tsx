import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import { useAdminStore } from "../../store/useAdminStore";
import { AdminLoginPage } from "./AdminLoginPage";

vi.mock("../../lib/adminApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/adminApi")>();
  return { ...actual, adminLogin: vi.fn() };
});

import * as adminApi from "../../lib/adminApi";

afterEach(() => {
  vi.restoreAllMocks();
  useAdminStore.getState().clearToken();
});

describe("AdminLoginPage", () => {
  it("ID とパスワードでログインすると管理者トークンを保存する", async () => {
    const user = userEvent.setup();
    vi.mocked(adminApi.adminLogin).mockResolvedValue({ accessToken: "admin-tok", tokenType: "bearer" });
    renderWithQueryClient(<AdminLoginPage />);

    await user.type(screen.getByLabelText("管理者ID"), "admin");
    await user.type(screen.getByLabelText("パスワード"), "pw-123456");
    await user.click(screen.getByRole("button", { name: "ログイン" }));

    await waitFor(() => expect(useAdminStore.getState().token).toBe("admin-tok"));
    expect(adminApi.adminLogin).toHaveBeenCalledWith("admin", "pw-123456");
  });

  it("失敗時は汎用的なエラーを表示し、トークンは保存しない", async () => {
    const user = userEvent.setup();
    vi.mocked(adminApi.adminLogin).mockRejectedValue(
      new adminApi.AdminApiError(401, "POST /api/admin/login failed: 401"),
    );
    renderWithQueryClient(<AdminLoginPage />);

    await user.type(screen.getByLabelText("管理者ID"), "admin");
    await user.type(screen.getByLabelText("パスワード"), "wrong");
    await user.click(screen.getByRole("button", { name: "ログイン" }));

    expect(await screen.findByText(/IDまたはパスワードが正しくありません/)).toBeInTheDocument();
    expect(useAdminStore.getState().token).toBeNull();
  });
});
