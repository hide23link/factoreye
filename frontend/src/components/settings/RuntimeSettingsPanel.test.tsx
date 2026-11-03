import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/errors";
import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { RuntimeSettings } from "../../types";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchRuntimeSettings: vi.fn(),
  unlockRuntimeSettings: vi.fn(),
  saveRuntimeSettings: vi.fn(),
  changeRuntimePassword: vi.fn(),
  reflectRuntimeSettings: vi.fn(),
  waitForBackendRestart: vi.fn(),
}));

import * as api from "../../lib/api";

const settings: RuntimeSettings = {
  ingestApiKeyConfigured: true,
  ingestAuth: "key",
  ingestAutoCreate: false,
  ingestAutoCreateMaxSensors: 100,
  ingestDeviceTime: false,
  ingestRateLimit: "100/minute",
  ingestCacheSeconds: 5,
  webhookAllowPrivateNetworks: false,
  frontendUrl: "http://192.168.0.20:3001",
  passwordConfigured: true,
  fileChanged: false,
};

beforeEach(() => {
  vi.mocked(api.fetchRuntimeSettings).mockResolvedValue(settings);
  vi.mocked(api.waitForBackendRestart).mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 「変更する」→ パスワード入力 → 編集中の状態にする。 */
async function startEditing(user: ReturnType<typeof userEvent.setup>) {
  vi.mocked(api.unlockRuntimeSettings).mockResolvedValue({ token: "tok", expiresInSeconds: 1800 });
  await user.click(await screen.findByRole("button", { name: "変更する" }));
  await user.type(screen.getByLabelText("管理パスワード", { selector: "input" }), "secret-pass");
  await user.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("button", { name: "保存して再起動" });
}

describe("RuntimeSettingsPanel", () => {
  it("開いた直後は閲覧のみ。鍵の値は表示せず、入力欄は触れない", async () => {
    renderWithQueryClient(<RuntimeSettingsPanel />);

    expect(await screen.findByText("🔒 閲覧のみ")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/設定済み/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /自動で/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "保存して再起動" })).toBeNull();
  });

  it("管理パスワードが違うと、エラーを出して編集に入らない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.unlockRuntimeSettings).mockRejectedValue(new ApiError(401, "POST failed: 401"));
    renderWithQueryClient(<RuntimeSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "変更する" }));
    await user.type(screen.getByLabelText("管理パスワード", { selector: "input" }), "wrong");
    await user.click(screen.getByRole("button", { name: "開く" }));

    expect(await screen.findByText("パスワードが違います。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存して再起動" })).toBeNull();
  });

  it("変えた項目だけを、許可証つきで保存し、再起動を待ってから完了を知らせる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveRuntimeSettings).mockResolvedValue({ restarting: true });
    renderWithQueryClient(<RuntimeSettingsPanel />);
    await startEditing(user);

    await user.click(screen.getByRole("radio", { name: /off/ }));
    await user.click(screen.getByRole("button", { name: "保存して再起動" }));

    await waitFor(() => expect(api.saveRuntimeSettings).toHaveBeenCalledWith({ INGEST_AUTH: "off" }, "tok"));
    expect(api.waitForBackendRestart).toHaveBeenCalled();
    expect(await screen.findByText(/保存して、再起動しました/)).toBeInTheDocument();
    expect(api.fetchRuntimeSettings).toHaveBeenCalledTimes(2); // 再起動のあと、取り直した
  });

  it("何も変えずに保存しようとしたら、送らずに知らせる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<RuntimeSettingsPanel />);
    await startEditing(user);

    await user.click(screen.getByRole("button", { name: "保存して再起動" }));

    expect(await screen.findByText(/変更された項目がありません/)).toBeInTheDocument();
    expect(api.saveRuntimeSettings).not.toHaveBeenCalled();
  });

  it("検査の誤りは、項目ごとに並べて出し、編集は続けられる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveRuntimeSettings).mockRejectedValue(
      new ApiError(422, 'PUT failed: 422 {"detail":["INGEST_RATE_LIMIT: 値の形が正しくありません"]}'),
    );
    renderWithQueryClient(<RuntimeSettingsPanel />);
    await startEditing(user);

    await user.click(screen.getByRole("radio", { name: /off/ }));
    await user.click(screen.getByRole("button", { name: "保存して再起動" }));

    expect(await screen.findByText("INGEST_RATE_LIMIT: 値の形が正しくありません")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存して再起動" })).toBeInTheDocument();
    expect(api.waitForBackendRestart).not.toHaveBeenCalled();
  });

  it("許可証の期限が切れていたら（401）、解錠し直しを案内して編集を終える", async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveRuntimeSettings).mockRejectedValue(new ApiError(401, "PUT failed: 401"));
    renderWithQueryClient(<RuntimeSettingsPanel />);
    await startEditing(user);

    await user.click(screen.getByRole("radio", { name: /off/ }));
    await user.click(screen.getByRole("button", { name: "保存して再起動" }));

    expect(await screen.findByText(/管理パスワードの確認が切れました/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "変更する" })).toBeInTheDocument();
  });

  it("再起動から戻らないときは、直前の設定に戻す方法を案内する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveRuntimeSettings).mockResolvedValue({ restarting: true });
    vi.mocked(api.waitForBackendRestart).mockResolvedValue(false);
    renderWithQueryClient(<RuntimeSettingsPanel />);
    await startEditing(user);

    await user.click(screen.getByRole("radio", { name: /off/ }));
    await user.click(screen.getByRole("button", { name: "保存して再起動" }));

    expect(await screen.findByText(/restore-env/)).toBeInTheDocument();
  });

  it(".env が書き換えられていたら帯を出し、反映ボタン（パスワードなし）で反映する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchRuntimeSettings).mockResolvedValue({ ...settings, fileChanged: true });
    vi.mocked(api.reflectRuntimeSettings).mockResolvedValue({ restarting: true });
    renderWithQueryClient(<RuntimeSettingsPanel />);

    expect(await screen.findByText(/まだ反映前/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ファイルの内容を反映" }));

    await waitFor(() => expect(api.reflectRuntimeSettings).toHaveBeenCalled());
    expect(api.unlockRuntimeSettings).not.toHaveBeenCalled();
    expect(await screen.findByText(/内容を反映しました/)).toBeInTheDocument();
  });

  it("反映で .env に誤りがあれば、その一覧を出して再起動を待たない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.reflectRuntimeSettings).mockRejectedValue(
      new ApiError(422, 'POST failed: 422 {"detail":["INGEST_AUTH: Input should be \'key\' or \'off\'"]}'),
    );
    renderWithQueryClient(<RuntimeSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "ファイルの内容を反映" }));

    expect(await screen.findByText(/INGEST_AUTH: Input should be/)).toBeInTheDocument();
    expect(api.waitForBackendRestart).not.toHaveBeenCalled();
  });

  it("変更がないのに反映を押したら、変わっていないと知らせる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.reflectRuntimeSettings).mockRejectedValue(new ApiError(409, "POST failed: 409"));
    renderWithQueryClient(<RuntimeSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "ファイルの内容を反映" }));

    expect(await screen.findByText(/起動したときから変わっていません/)).toBeInTheDocument();
  });

  it("管理パスワードが未設定なら、変更できず、設定方法を案内する", async () => {
    vi.mocked(api.fetchRuntimeSettings).mockResolvedValue({ ...settings, passwordConfigured: false });
    renderWithQueryClient(<RuntimeSettingsPanel />);

    expect(await screen.findByText(/管理パスワードが未設定/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "変更する" })).toBeDisabled();
  });
});
