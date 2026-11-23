import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PasskeyCancelledError } from "../../lib/passkey";
import { useAuthStore } from "../../store/useAuthStore";
import { renderWithQueryClient as render, screen, waitFor, within } from "../../test/test-utils";
import type { KeptSession, MeResponse, PasskeyItem } from "../../types";
import { PasskeysSettingsPanel } from "./PasskeysSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchPasskeys: vi.fn(),
  beginAddPasskey: vi.fn(),
  finishAddPasskey: vi.fn(),
  renamePasskey: vi.fn(),
  deletePasskey: vi.fn(),
  fetchKeptSessions: vi.fn(),
  keepSignedIn: vi.fn(),
  endKeptSession: vi.fn(),
}));
vi.mock("../../lib/passkey", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/passkey")>()),
  createPasskey: vi.fn(),
}));

import * as api from "../../lib/api";
import * as passkey from "../../lib/passkey";

const ME: MeResponse = {
  userId: "u",
  email: "a@example.com",
  workspaceId: "w",
  workspaceName: "a",
  plan: "free",
  loginMethod: "passkey",
};

function key(over: Partial<PasskeyItem> = {}): PasskeyItem {
  return {
    id: "k1",
    name: "Mac の Chrome",
    credentialId: "cred1",
    createdAt: "2026-11-01T00:00:00Z",
    lastUsedAt: "2026-11-20T00:00:00Z",
    ...over,
  };
}

function kept(over: Partial<KeptSession> = {}): KeptSession {
  return { id: "s1", name: "壁掛けの画面", startedAt: "2026-11-10T00:00:00Z", lastUsedAt: "2026-11-23T00:00:00Z", ...over };
}

beforeEach(() => {
  useAuthStore.setState({ me: ME });
  vi.mocked(api.fetchPasskeys).mockResolvedValue([key(), key({ id: "k2", name: "iPhone", lastUsedAt: null })]);
  vi.mocked(api.fetchKeptSessions).mockResolvedValue([]);
});

afterEach(() => {
  vi.resetAllMocks();
  useAuthStore.setState({ me: null });
  localStorage.clear();
});

describe("端末（パスキー）の一覧", () => {
  it("名前・登録日・最後に使った日を出す", async () => {
    render(<PasskeysSettingsPanel />);

    expect(await screen.findByText("Mac の Chrome")).toBeInTheDocument();
    expect(screen.getByText("iPhone")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0); // 一度も使っていない端末
  });

  it("最後の 1 台は、削除できない", async () => {
    vi.mocked(api.fetchPasskeys).mockResolvedValue([key()]);
    render(<PasskeysSettingsPanel />);

    expect(await screen.findByRole("button", { name: "Mac の Chrome を削除" })).toBeDisabled();
    expect(screen.getByText(/端末が 1 台だけです/)).toBeInTheDocument();
  });

  it("確認してから削除する（やめれば削除しない）", async () => {
    vi.mocked(api.deletePasskey).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PasskeysSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "iPhone を削除" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(api.deletePasskey).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "iPhone を削除" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(api.deletePasskey).toHaveBeenCalledWith("k2"));
  });

  it("名前を変えられる", async () => {
    vi.mocked(api.renamePasskey).mockResolvedValue(key({ name: "仕事の Mac" }));
    const user = userEvent.setup();
    render(<PasskeysSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "Mac の Chrome の名前を変える" }));
    const input = screen.getByRole("textbox", { name: "端末の名前" });
    await user.clear(input);
    await user.type(input, "仕事の Mac{Enter}");

    await waitFor(() => expect(api.renamePasskey).toHaveBeenCalledWith("k1", "仕事の Mac"));
  });

  it("この端末を追加できる（端末の確認画面を出して、パスキーを送る）", async () => {
    vi.mocked(api.beginAddPasskey).mockResolvedValue({ challengeId: "c1", options: { challenge: "x" } });
    vi.mocked(passkey.createPasskey).mockResolvedValue({ id: "new" });
    vi.mocked(api.finishAddPasskey).mockResolvedValue(key({ id: "k3" }));
    const user = userEvent.setup();
    render(<PasskeysSettingsPanel />);

    const name = await screen.findByLabelText("この端末の名前", { selector: "#new-passkey-name" });
    await user.clear(name);
    await user.type(name, "新しい iPad");
    await user.click(screen.getByRole("button", { name: "＋ この端末を追加" }));

    await waitFor(() =>
      expect(api.finishAddPasskey).toHaveBeenCalledWith({
        challengeId: "c1",
        credential: { id: "new" },
        deviceName: "新しい iPad",
      }),
    );
  });

  it("端末の画面をやめただけなら、エラーを出さない", async () => {
    vi.mocked(api.beginAddPasskey).mockResolvedValue({ challengeId: "c1", options: {} });
    vi.mocked(passkey.createPasskey).mockRejectedValue(new PasskeyCancelledError());
    const user = userEvent.setup();
    render(<PasskeysSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "＋ この端末を追加" }));

    await waitFor(() => expect(passkey.createPasskey).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("メールのログインリンクで入っているときは、端末の管理を出さず、理由を案内する", async () => {
    useAuthStore.setState({ me: { ...ME, loginMethod: "email" } });
    render(<PasskeysSettingsPanel />);

    expect(screen.getByText(/メールのリンクでログインしているため/)).toHaveTextContent(
      /端末（パスキー）の追加・削除はできません/,
    );
    expect(screen.queryByRole("button", { name: "＋ この端末を追加" })).not.toBeInTheDocument();
    expect(api.fetchPasskeys).not.toHaveBeenCalled();
    // キオスク用の設定は、メールのログインでも選べる
    expect(screen.getByRole("button", { name: "この端末はログインしたままにする（キオスク用）" })).toBeInTheDocument();
  });
});

describe("ログインしたままにする（キオスク用）", () => {
  it("選ぶ前に、リスクを見せて確認する。確認すると、今のリフレッシュトークンで期限なしにする", async () => {
    localStorage.setItem("factoreye_rt", "refresh-token-value");
    vi.mocked(api.keepSignedIn).mockResolvedValue(kept());
    const user = userEvent.setup();
    render(<PasskeysSettingsPanel />);

    expect(screen.getByText(/リスク: この端末を盗まれると/)).toHaveTextContent(
      "その人があなたの全権限で使い続けられます",
    );
    const name = screen.getByLabelText("この端末の名前", { selector: "#kept-device-name" });
    await user.clear(name);
    await user.type(name, "工場の壁掛け");
    await user.click(screen.getByRole("button", { name: "この端末はログインしたままにする（キオスク用）" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("この端末を盗まれると");
    expect(api.keepSignedIn).not.toHaveBeenCalled(); // 確認するまで、何もしない
    await user.click(within(dialog).getByRole("button", { name: "ログインしたままにする" }));

    await waitFor(() => expect(api.keepSignedIn).toHaveBeenCalledWith("refresh-token-value", "工場の壁掛け"));
  });

  it("確認でやめれば、設定しない", async () => {
    const user = userEvent.setup();
    render(<PasskeysSettingsPanel />);

    await user.click(screen.getByRole("button", { name: "この端末はログインしたままにする（キオスク用）" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(api.keepSignedIn).not.toHaveBeenCalled();
  });

  it("永久ログインの端末の一覧（名前・開始日・最後に使った日）を出し、「ログインを終了」できる", async () => {
    vi.mocked(api.fetchKeptSessions).mockResolvedValue([kept()]);
    vi.mocked(api.endKeptSession).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PasskeysSettingsPanel />);

    const table = await screen.findByRole("table", { name: "ログインしたままの端末" });
    expect(within(table).getByText("壁掛けの画面")).toBeInTheDocument();
    expect(within(table).getByText(new Date("2026-11-10T00:00:00Z").toLocaleDateString("ja-JP"))).toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "壁掛けの画面 のログインを終了" }));

    await waitFor(() => expect(api.endKeptSession).toHaveBeenCalledWith("s1"));
  });

  it("一覧が空なら、表を出さない", async () => {
    render(<PasskeysSettingsPanel />);
    await screen.findByText("Mac の Chrome");
    expect(screen.queryByRole("table", { name: "ログインしたままの端末" })).not.toBeInTheDocument();
  });
});
