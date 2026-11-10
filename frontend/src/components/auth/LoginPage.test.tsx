import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/errors";
import { render, screen } from "../../test/test-utils";
import { LoginPage } from "./LoginPage";

vi.mock("../../lib/api", () => ({
  loginUser: vi.fn(),
  registerUser: vi.fn(),
  fetchMe: vi.fn(),
}));

import * as api from "../../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

async function submitLogin() {
  const user = userEvent.setup();
  render(<LoginPage onAuthenticated={() => {}} />);
  await user.click(screen.getByRole("button", { name: "ログイン" }));
  await user.type(screen.getByLabelText("メールアドレス"), "a@example.com");
  await user.type(screen.getByLabelText("パスワード"), "wrong-pass");
  await user.click(screen.getAllByRole("button", { name: "ログイン" }).at(-1)!);
}

describe("LoginPage", () => {
  it("パスワード誤り（401）は、HTTP の文言ではなく日本語で表示する", async () => {
    vi.mocked(api.loginUser).mockRejectedValue(
      new ApiError(401, 'POST /api/auth/login failed: 401 {"detail":"invalid"}'),
    );
    await submitLogin();

    expect(await screen.findByText("メールアドレスまたはパスワードが正しくありません。")).toBeInTheDocument();
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it("通信に失敗したときは、接続の失敗を表示する", async () => {
    vi.mocked(api.loginUser).mockRejectedValue(new TypeError("Failed to fetch"));
    await submitLogin();

    expect(await screen.findByText(/接続できませんでした/)).toBeInTheDocument();
  });

  it("セルフホストの案内は、正しい GitHub のリポジトリへリンクする", () => {
    render(<LoginPage onAuthenticated={() => {}} />);

    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/hide23link/factoreye",
    );
  });

  it("グラフのリンクから来たときは、ログインのタブで開き、案内を出す。ログインしても URL のリンクは残る（その後リンクの画面を開く）", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?dashboard=3f8c2a1e-7b4d-4e19-9a52-c0d1e6f2a8b3&graph=9d41b7c2-0e5a-4f38-b1d6-7a2c9e4f0b13&range=30m");
    vi.mocked(api.loginUser).mockResolvedValue({ accessToken: "a", refreshToken: "r" } as Awaited<ReturnType<typeof api.loginUser>>);
    vi.mocked(api.fetchMe).mockResolvedValue({} as Awaited<ReturnType<typeof api.fetchMe>>);
    const onAuthenticated = vi.fn();
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    expect(screen.getByText("ログインすると、リンクのグラフを開きます")).toBeInTheDocument();
    await user.type(screen.getByLabelText("メールアドレス"), "a@example.com");
    await user.type(screen.getByLabelText("パスワード"), "password1");
    await user.click(screen.getAllByRole("button", { name: "ログイン" }).at(-1)!);

    expect(onAuthenticated).toHaveBeenCalled();
    expect(window.location.search).toBe("?dashboard=3f8c2a1e-7b4d-4e19-9a52-c0d1e6f2a8b3&graph=9d41b7c2-0e5a-4f38-b1d6-7a2c9e4f0b13&range=30m");
  });

  it("リンクから来ていなければ、案内は出さない", () => {
    render(<LoginPage onAuthenticated={() => {}} />);
    expect(screen.queryByText("ログインすると、リンクのグラフを開きます")).not.toBeInTheDocument();
  });
});
