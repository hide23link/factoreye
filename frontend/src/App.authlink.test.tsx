/**
 * SaaS 版（VITE_AUTH_MODE=multi_tenant）で、ログイン中にメールのリンクを開いたときの画面の切り替えを確かめる。
 * App.tsx は、動作モードをモジュールを読み込むときに決めるので、読み込む前に環境変数を差し替える。
 */
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubEnv("VITE_AUTH_MODE", "multi_tenant");
});

import App from "./App";
import { useAuthStore } from "./store/useAuthStore";
import { renderWithQueryClient, screen, waitFor } from "./test/test-utils";

vi.mock("./lib/api", () => ({
  fetchHealth: vi.fn(),
  fetchDashboard: vi.fn(),
  fetchDashboards: vi.fn(),
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  createDashboard: vi.fn(),
  fetchMe: vi.fn(),
  fetchAlarms: vi.fn(),
  fetchDisplaySettings: vi.fn(),
  logout: vi.fn(),
  refreshTokens: vi.fn(),
  beginPasskeyRegistration: vi.fn(),
  beginPasskeyLogin: vi.fn(),
  loginWithLink: vi.fn(),
  requestEmailLink: vi.fn(),
  requestLoginLink: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  finishPasskeyLogin: vi.fn(),
}));

import * as api from "./lib/api";

const ME = {
  userId: "u1",
  email: "current@example.com",
  workspaceId: "w1",
  workspaceName: "current",
  plan: "free" as const,
  loginMethod: "passkey" as const,
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.fetchHealth).mockResolvedValue({ status: "ok" } as Awaited<ReturnType<typeof api.fetchHealth>>);
  vi.mocked(api.fetchDashboards).mockResolvedValue([]);
  vi.mocked(api.fetchSensors).mockResolvedValue([]);
  vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });
  vi.mocked(api.fetchDisplaySettings).mockResolvedValue({ defaultTheme: "dark" });
  // ログインの復元を済ませた状態（ログイン中）にする
  useAuthStore.setState({ accessToken: "access", me: ME, isInitializing: false, impersonation: null });
  // 端末にリフレッシュトークンが無ければ、起動時の復元は何もしない（上の状態のまま）
});

afterEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ accessToken: null, me: null, isInitializing: false, impersonation: null });
  window.history.replaceState(null, "", "/");
});

function open(hash: string) {
  window.history.replaceState(null, "", `/${hash}`);
  return renderWithQueryClient(<App />);
}

describe("ログイン中にメールのリンクを開いたとき", () => {
  it.each([
    ["#recover=abcDEF123456", "端末の再登録のリンク", "端末を登録するための画面"],
    ["#register=abcDEF123456", "新規登録のリンク", "登録するための画面"],
    ["#login=abcDEF123456", "ログインのリンク", "ログインするための画面"],
  ])("%s は、ダッシュボードではなく確認の画面を出す（今のアドレス・終了すること・種類別の行き先・やめる案内）", (hash, label, action) => {
    open(hash);

    const dialog = screen.getByRole("dialog", { name: "メールのリンクを開こうとしています" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("current@example.com")).toBeInTheDocument();
    expect(screen.getByText("今のログインを終了")).toBeInTheDocument();
    expect(dialog).toHaveTextContent(action);
    // 知らないリンクのときの案内と、キオスク（ログインしたまま）の設定も終わることの注意
    expect(dialog).toHaveTextContent("知らないメールのリンクなら「やめる」を押してください。");
    expect(dialog).toHaveTextContent("ログインしたままにする（キオスク用）」の設定なら、続けると、その設定も終わります");
    // 開いただけでは、何も終わらず、リンクも使わない
    expect(useAuthStore.getState().accessToken).toBe("access");
    expect(api.logout).not.toHaveBeenCalled();
    expect(api.beginPasskeyRegistration).not.toHaveBeenCalled();
    expect(api.loginWithLink).not.toHaveBeenCalled();
  });

  it("「続ける」を押すと、今のログインを終了して、リンクの画面（登録）に進む", async () => {
    vi.mocked(api.beginPasskeyRegistration).mockResolvedValue({
      challengeId: "c1",
      options: {},
      email: "new@example.com",
      purpose: "register",
    });
    vi.mocked(api.logout).mockImplementation(async () => {
      useAuthStore.getState().clearAuth();
    });
    const user = userEvent.setup();
    open("#register=abcDEF123456");

    await user.click(screen.getByRole("button", { name: "続ける（今のログインを終了）" }));

    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("メールアドレスを確認しました")).toBeInTheDocument();
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(api.beginPasskeyRegistration).toHaveBeenCalledWith("abcDEF123456");
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it("ログインリンクで「続ける」と、今のログインを終えてから、リンクでログインする（1 回だけ）", async () => {
    vi.mocked(api.logout).mockImplementation(async () => {
      useAuthStore.getState().clearAuth();
    });
    vi.mocked(api.loginWithLink).mockResolvedValue({ accessToken: "new-access", refreshToken: "r", tokenType: "bearer" });
    vi.mocked(api.fetchMe).mockResolvedValue({ ...ME, email: "other@example.com", loginMethod: "email" });
    const user = userEvent.setup();
    open("#login=abcDEF123456");

    await user.click(screen.getByRole("button", { name: "続ける（今のログインを終了）" }));

    await waitFor(() => expect(useAuthStore.getState().accessToken).toBe("new-access"));
    expect(api.loginWithLink).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe(""); // 使い終えたリンクは消える
    // 処理が終わったあとは、確認の画面に戻らない
    expect(screen.queryByRole("dialog", { name: "メールのリンクを開こうとしています" })).not.toBeInTheDocument();
  });

  it("「やめる」を押すと、リンクを消して、今のまま（ダッシュボード）に戻る。ログインは終わらない", async () => {
    const user = userEvent.setup();
    open("#recover=abcDEF123456");

    await user.click(screen.getByRole("button", { name: "やめる（今のまま使う）" }));

    expect(window.location.hash).toBe("");
    expect(screen.queryByRole("dialog", { name: "メールのリンクを開こうとしています" })).not.toBeInTheDocument();
    expect(useAuthStore.getState().accessToken).toBe("access");
    expect(api.logout).not.toHaveBeenCalled();
    expect(api.beginPasskeyRegistration).not.toHaveBeenCalled();
  });

  it("リンクが無ければ、今までどおりダッシュボードを出す", () => {
    open("");

    expect(screen.queryByRole("dialog", { name: "メールのリンクを開こうとしています" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "メインメニュー" })).toBeInTheDocument();
  });

  it("リンクの形でない # は、リンクとして扱わない", () => {
    open("#something-else");

    expect(screen.queryByRole("dialog", { name: "メールのリンクを開こうとしています" })).not.toBeInTheDocument();
  });

  it("管理者が利用者として閲覧中のタブでは、確認の画面を出さない", () => {
    useAuthStore.setState({
      impersonation: { accessToken: "imp", email: "x@example.com", workspaceName: "x", expiresAt: Date.now() + 60000 },
    });
    open("#recover=abcDEF123456");

    expect(screen.queryByRole("dialog", { name: "メールのリンクを開こうとしています" })).not.toBeInTheDocument();
  });
});

describe("ログインしていないとき", () => {
  it("リンクで開くと、今までどおり、リンクの画面（ログイン画面の中）を出す", async () => {
    useAuthStore.setState({ accessToken: null, me: null });
    vi.mocked(api.beginPasskeyRegistration).mockResolvedValue({
      challengeId: "c1",
      options: {},
      email: "first@example.com",
      purpose: "recover",
    });
    open("#recover=abcDEF123456");

    expect(await screen.findByText("first@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "メールのリンクを開こうとしています" })).not.toBeInTheDocument();
  });
});
