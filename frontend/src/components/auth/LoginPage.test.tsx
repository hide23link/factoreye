import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/errors";
import { PasskeyCancelledError } from "../../lib/passkey";
import { useAuthStore } from "../../store/useAuthStore";
import { render, screen, waitFor } from "../../test/test-utils";
import { LoginPage } from "./LoginPage";

vi.mock("../../lib/api", () => ({
  fetchMe: vi.fn(),
  requestEmailLink: vi.fn(),
  requestLoginLink: vi.fn(),
  loginWithLink: vi.fn(),
  beginPasskeyRegistration: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  beginPasskeyLogin: vi.fn(),
  finishPasskeyLogin: vi.fn(),
}));
vi.mock("../../lib/passkey", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/passkey")>()),
  isPasskeySupported: vi.fn(() => true),
  getPasskey: vi.fn(),
  createPasskey: vi.fn(),
}));

import * as api from "../../lib/api";
import * as passkey from "../../lib/passkey";

const ME = { userId: "u", email: "a@example.com", workspaceId: "w", workspaceName: "a", plan: "free" as const };

beforeEach(() => {
  vi.mocked(passkey.isPasskeySupported).mockReturnValue(true);
});

afterEach(() => {
  vi.resetAllMocks();
  useAuthStore.setState({ accessToken: null, me: null });
  window.history.replaceState(null, "", "/");
});

async function openLoginTab() {
  const user = userEvent.setup();
  render(<LoginPage onAuthenticated={() => {}} />);
  await user.click(screen.getByRole("button", { name: "ログイン" }));
  return user;
}

describe("新規登録", () => {
  it("メールアドレスだけを入れる（パスワード・ワークスペース名の欄は無い）", () => {
    render(<LoginPage onAuthenticated={() => {}} />);
    expect(screen.getByLabelText("メールアドレス")).toBeInTheDocument();
    expect(screen.queryByLabelText(/パスワード/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/ワークスペース/)).not.toBeInTheDocument();
  });

  it("確認メールを送り、案内を出す（アドレスが登録済みかは区別しない）", async () => {
    vi.mocked(api.requestEmailLink).mockResolvedValue({ status: "sent" });
    const user = userEvent.setup();
    render(<LoginPage onAuthenticated={() => {}} />);

    await user.type(screen.getByLabelText("メールアドレス"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "確認メールを送る" }));

    expect(api.requestEmailLink).toHaveBeenCalledWith("new@example.com");
    expect(await screen.findByText(/new@example.com に確認メールを送りました/)).toBeInTheDocument();
    expect(screen.getByText(/1 時間に 3 通まで/)).toBeInTheDocument();
  });

  it("メールを送れない設定（503）のときは、その理由を出す", async () => {
    vi.mocked(api.requestEmailLink).mockRejectedValue(new ApiError(503, "x"));
    const user = userEvent.setup();
    render(<LoginPage onAuthenticated={() => {}} />);

    await user.type(screen.getByLabelText("メールアドレス"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "確認メールを送る" }));

    expect(await screen.findByText(/メールを送れない設定/)).toBeInTheDocument();
  });
});

describe("パスキーでログイン", () => {
  it("押すだけでログインできる（アドレスは聞かない）", async () => {
    vi.mocked(api.beginPasskeyLogin).mockResolvedValue({ challengeId: "c1", options: { challenge: "x" } });
    vi.mocked(passkey.getPasskey).mockResolvedValue({ id: "cred" });
    vi.mocked(api.finishPasskeyLogin).mockResolvedValue({ accessToken: "a", refreshToken: "r", tokenType: "bearer" });
    vi.mocked(api.fetchMe).mockResolvedValue(ME);
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<LoginPage onAuthenticated={onAuthenticated} />);
    await user.click(screen.getByRole("button", { name: "ログイン" }));

    expect(screen.queryByLabelText("メールアドレス")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "パスキーでログイン" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(passkey.getPasskey).toHaveBeenCalledWith({ challenge: "x" });
    expect(api.finishPasskeyLogin).toHaveBeenCalledWith({ challengeId: "c1", credential: { id: "cred" } });
    expect(useAuthStore.getState().accessToken).toBe("a");
  });

  it("端末の画面をやめただけなら、エラーを出さない", async () => {
    vi.mocked(api.beginPasskeyLogin).mockResolvedValue({ challengeId: "c1", options: {} });
    vi.mocked(passkey.getPasskey).mockRejectedValue(new PasskeyCancelledError());
    const user = await openLoginTab();

    await user.click(screen.getByRole("button", { name: "パスキーでログイン" }));

    await waitFor(() => expect(passkey.getPasskey).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("確かめられなかった（401）ときは、HTTP の文言ではなく日本語で表示する", async () => {
    vi.mocked(api.beginPasskeyLogin).mockResolvedValue({ challengeId: "c1", options: {} });
    vi.mocked(passkey.getPasskey).mockResolvedValue({});
    vi.mocked(api.finishPasskeyLogin).mockRejectedValue(new ApiError(401, "POST x failed: 401"));
    const user = await openLoginTab();

    await user.click(screen.getByRole("button", { name: "パスキーでログイン" }));

    expect(await screen.findByText("パスキーを確かめられませんでした。もう一度お試しください。")).toBeInTheDocument();
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it("通信に失敗したときは、接続の失敗を表示する", async () => {
    vi.mocked(api.beginPasskeyLogin).mockRejectedValue(new TypeError("Failed to fetch"));
    const user = await openLoginTab();

    await user.click(screen.getByRole("button", { name: "パスキーでログイン" }));

    expect(await screen.findByText(/接続できませんでした/)).toBeInTheDocument();
  });

  it("パスキーに対応していないブラウザでは、案内を出してボタンを押せなくする（メールでログインは使える）", async () => {
    vi.mocked(passkey.isPasskeySupported).mockReturnValue(false);
    await openLoginTab();

    expect(screen.getByRole("alert")).toHaveTextContent("パスキーに対応していません");
    expect(screen.getByRole("button", { name: "パスキーでログイン" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "パスキーが使えない・メールでログイン" })).toBeEnabled();
  });
});

describe("メールでログイン（パスキーが使えないとき）", () => {
  it("アドレスを入れて、ログインのリンクを送る。応答はどのアドレスも同じ文言", async () => {
    vi.mocked(api.requestLoginLink).mockResolvedValue({ status: "sent" });
    const user = await openLoginTab();

    await user.click(screen.getByRole("button", { name: "パスキーが使えない・メールでログイン" }));
    expect(screen.getByText(/15 分・1 回だけ/)).toBeInTheDocument();
    expect(screen.getByText(/端末（パスキー）の追加・削除はできません/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("メールアドレス"), "who@example.com");
    await user.click(screen.getByRole("button", { name: "ログインのリンクを送る" }));

    expect(api.requestLoginLink).toHaveBeenCalledWith("who@example.com");
    expect(await screen.findByText(/登録されているアドレスなら、ログインのリンクを送りました。15 分以内/)).toBeInTheDocument();
  });

  it("パスキーでのログインに戻れる", async () => {
    const user = await openLoginTab();
    await user.click(screen.getByRole("button", { name: "パスキーが使えない・メールでログイン" }));
    await user.click(screen.getByRole("button", { name: "パスキーでログインに戻る" }));
    expect(screen.getByRole("button", { name: "パスキーでログイン" })).toBeInTheDocument();
  });
});

describe("端末を失くしたとき", () => {
  it("再登録のメールを送る（登録と同じ入口。応答は同じ文言）", async () => {
    vi.mocked(api.requestEmailLink).mockResolvedValue({ status: "sent" });
    const user = await openLoginTab();

    await user.click(screen.getByRole("button", { name: "端末を失くした・パスキーがない" }));
    await user.type(screen.getByLabelText("メールアドレス"), "lost@example.com");
    await user.click(screen.getByRole("button", { name: "再登録のメールを送る" }));

    expect(api.requestEmailLink).toHaveBeenCalledWith("lost@example.com");
    expect(await screen.findByText(/1 時間以内にリンクを開いてください/)).toBeInTheDocument();
  });
});

describe("メールのリンクを開いたとき", () => {
  it("ログインリンク: 開くとすぐログインする。パスキーの登録は求めず、使い終えたトークンを URL から消す", async () => {
    window.history.replaceState(null, "", "/#login=abcDEF123456");
    vi.mocked(api.loginWithLink).mockResolvedValue({ accessToken: "a", refreshToken: "r", tokenType: "bearer" });
    vi.mocked(api.fetchMe).mockResolvedValue({ ...ME, loginMethod: "email" });
    render(<LoginPage onAuthenticated={() => {}} />);

    await waitFor(() => expect(useAuthStore.getState().accessToken).toBe("a"));
    expect(api.loginWithLink).toHaveBeenCalledTimes(1);
    expect(api.loginWithLink).toHaveBeenCalledWith("abcDEF123456");
    expect(api.beginPasskeyRegistration).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("ログインリンクが期限切れ・使用済み（410）なら、理由を出してログイン画面へ戻れる", async () => {
    window.history.replaceState(null, "", "/#login=abcDEF123456");
    vi.mocked(api.loginWithLink).mockRejectedValue(new ApiError(410, "x"));
    const user = userEvent.setup();
    render(<LoginPage onAuthenticated={() => {}} />);

    expect(await screen.findByText(/期限が切れたか、すでに使われています/)).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    await user.click(screen.getByRole("button", { name: "ログイン画面へ" }));
    expect(screen.getByRole("button", { name: "パスキーでログイン" })).toBeInTheDocument();
  });

  it("登録リンク: メールの確認を見せ、端末の名前を付けてパスキーを登録するとログインする", async () => {
    window.history.replaceState(null, "", "/#register=abcDEF123456");
    vi.mocked(api.beginPasskeyRegistration).mockResolvedValue({
      challengeId: "c9",
      options: { challenge: "x" },
      email: "tanaka@example.com",
      purpose: "register",
    });
    vi.mocked(passkey.createPasskey).mockResolvedValue({ id: "new" });
    vi.mocked(api.finishPasskeyRegistration).mockResolvedValue({ accessToken: "a", refreshToken: "r", tokenType: "bearer" });
    vi.mocked(api.fetchMe).mockResolvedValue({ ...ME, loginMethod: "passkey" });
    const user = userEvent.setup();
    render(<LoginPage onAuthenticated={() => {}} />);

    expect(await screen.findByText("メールアドレスを確認しました")).toBeInTheDocument();
    expect(screen.getByText("tanaka@example.com")).toBeInTheDocument();
    const name = screen.getByLabelText("この端末の名前");
    await user.clear(name);
    await user.type(name, "事務所の Mac");
    await user.click(screen.getByRole("button", { name: "パスキーを登録する" }));

    await waitFor(() => expect(useAuthStore.getState().accessToken).toBe("a"));
    expect(api.beginPasskeyRegistration).toHaveBeenCalledTimes(1);
    expect(api.finishPasskeyRegistration).toHaveBeenCalledWith({
      challengeId: "c9",
      credential: { id: "new" },
      deviceName: "事務所の Mac",
    });
    expect(window.location.hash).toBe("");
  });

  it("再登録リンクでは、新しい端末を登録する案内を出す。端末の画面をやめても、エラーにせず、もう一度押せる", async () => {
    window.history.replaceState(null, "", "/#recover=abcDEF123456");
    vi.mocked(api.beginPasskeyRegistration).mockResolvedValue({
      challengeId: "c9",
      options: {},
      email: "lost@example.com",
      purpose: "recover",
    });
    vi.mocked(passkey.createPasskey).mockRejectedValue(new PasskeyCancelledError());
    const user = userEvent.setup();
    render(<LoginPage onAuthenticated={() => {}} />);

    expect(await screen.findByText(/新しい端末にパスキーを登録します/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "パスキーを登録する" }));

    await waitFor(() => expect(passkey.createPasskey).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "パスキーを登録する" })).toBeEnabled();
  });

  it("登録リンクが使えない（410）ときは、理由を出す", async () => {
    window.history.replaceState(null, "", "/#register=abcDEF123456");
    vi.mocked(api.beginPasskeyRegistration).mockRejectedValue(new ApiError(410, "x"));
    render(<LoginPage onAuthenticated={() => {}} />);

    expect(await screen.findByText(/期限が切れたか、すでに使われています/)).toBeInTheDocument();
  });
});

describe("その他", () => {
  it("セルフホストの案内は、正しい GitHub のリポジトリへリンクする", () => {
    render(<LoginPage onAuthenticated={() => {}} />);

    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/hide23link/factoreye",
    );
  });

  it("グラフのリンクから来たときは、ログインのタブで開き、案内を出す。URL のリンクは残る", async () => {
    window.history.replaceState(
      null,
      "",
      "/?dashboard=3f8c2a1e-7b4d-4e19-9a52-c0d1e6f2a8b3&graph=9d41b7c2-0e5a-4f38-b1d6-7a2c9e4f0b13&range=30m",
    );
    vi.mocked(api.beginPasskeyLogin).mockResolvedValue({ challengeId: "c1", options: {} });
    vi.mocked(passkey.getPasskey).mockResolvedValue({});
    vi.mocked(api.finishPasskeyLogin).mockResolvedValue({ accessToken: "a", refreshToken: "r", tokenType: "bearer" });
    vi.mocked(api.fetchMe).mockResolvedValue(ME);
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    expect(screen.getByText("ログインすると、リンクのグラフを開きます")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "パスキーでログイン" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(window.location.search).toBe(
      "?dashboard=3f8c2a1e-7b4d-4e19-9a52-c0d1e6f2a8b3&graph=9d41b7c2-0e5a-4f38-b1d6-7a2c9e4f0b13&range=30m",
    );
  });

  it("リンクから来ていなければ、案内は出さない", () => {
    render(<LoginPage onAuthenticated={() => {}} />);
    expect(screen.queryByText("ログインすると、リンクのグラフを開きます")).not.toBeInTheDocument();
  });
});
