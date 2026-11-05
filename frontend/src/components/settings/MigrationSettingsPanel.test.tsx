import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { MigrationStatus } from "../../types";
import { MigrationSettingsPanel } from "./MigrationSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchMigrationStatus: vi.fn(),
  downloadWorkspaceExport: vi.fn(),
  importWorkspaceFile: vi.fn(),
}));

import * as api from "../../lib/api";

const selfHosted: MigrationStatus = { mode: "self_hosted", canExport: true, canImport: true };
const saas: MigrationStatus = { mode: "multi_tenant", canExport: true, canImport: false };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MigrationSettingsPanel", () => {
  it("OSS版では書き出しと取り込みの両方を表示する", async () => {
    vi.mocked(api.fetchMigrationStatus).mockResolvedValue(selfHosted);
    renderWithQueryClient(<MigrationSettingsPanel />);

    expect(await screen.findByText("取り込み（OSS へ移す）")).toBeInTheDocument();
    expect(
      screen.getByText("書き出し（バックアップ・他サーバーへの移行）"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "書き出す" })).toBeInTheDocument();
  });

  it("SaaS版では書き出しだけ表示する", async () => {
    vi.mocked(api.fetchMigrationStatus).mockResolvedValue(saas);
    renderWithQueryClient(<MigrationSettingsPanel />);

    expect(await screen.findByRole("button", { name: "書き出す" })).toBeInTheDocument();
    expect(screen.getByText("書き出し（SaaS → OSS）")).toBeInTheDocument();
    expect(screen.queryByText("取り込み（OSS へ移す）")).not.toBeInTheDocument();
  });

  it("OSS版で書き出すと、ダウンロードが始まる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMigrationStatus).mockResolvedValue(selfHosted);
    const blob = new Blob(["dummy"], { type: "application/gzip" });
    vi.mocked(api.downloadWorkspaceExport).mockResolvedValue(blob);
    renderWithQueryClient(<MigrationSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "書き出す" }));

    await waitFor(() => expect(api.downloadWorkspaceExport).toHaveBeenCalled());
  });

  it("どちらも使えないモードでは理由を表示する", async () => {
    vi.mocked(api.fetchMigrationStatus).mockResolvedValue({
      mode: "self_hosted",
      canExport: false,
      canImport: false,
    });
    renderWithQueryClient(<MigrationSettingsPanel />);

    expect(await screen.findByText(/移行機能を使えません/)).toBeInTheDocument();
  });

  it("ファイルを確認してから、件数を見て取り込む", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMigrationStatus).mockResolvedValue(selfHosted);
    vi.mocked(api.importWorkspaceFile)
      .mockResolvedValueOnce({ dryRun: true, counts: { sensors: 2, readings: 300 } })
      .mockResolvedValueOnce({ dryRun: false, counts: { sensors: 2, readings: 300 } });
    renderWithQueryClient(<MigrationSettingsPanel />);

    const file = new File(["x"], "workspace.jsonl.gz", { type: "application/gzip" });
    const input = await screen.findByLabelText("取り込むファイル");
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "内容を確認" }));

    expect(await screen.findByText("センサー: 2 件")).toBeInTheDocument();
    expect(screen.getByText("測定値: 300 件")).toBeInTheDocument();
    expect(api.importWorkspaceFile).toHaveBeenLastCalledWith(file, {
      dryRun: true,
      withNotifications: false,
    });

    await user.click(screen.getByRole("button", { name: "この内容で取り込む" }));

    await waitFor(() =>
      expect(api.importWorkspaceFile).toHaveBeenLastCalledWith(file, {
        dryRun: false,
        withNotifications: false,
      }),
    );
    expect(await screen.findByText("取り込みが完了しました")).toBeInTheDocument();
  });

  it("確認で失敗したらサーバーの理由を表示し、取り込みボタンは出さない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMigrationStatus).mockResolvedValue(selfHosted);
    vi.mocked(api.importWorkspaceFile).mockRejectedValue(
      new Error("スキーマ版が違います（書き出し: a、移行先: b）"),
    );
    renderWithQueryClient(<MigrationSettingsPanel />);

    const file = new File(["x"], "workspace.jsonl.gz", { type: "application/gzip" });
    const input = await screen.findByLabelText("取り込むファイル");
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "内容を確認" }));

    expect(await screen.findByText(/スキーマ版が違います/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "この内容で取り込む" })).not.toBeInTheDocument();
  });

  it("通知設定の切り替えで確認結果を消す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchMigrationStatus).mockResolvedValue(selfHosted);
    vi.mocked(api.importWorkspaceFile).mockResolvedValue({
      dryRun: true,
      counts: { sensors: 1 },
    });
    renderWithQueryClient(<MigrationSettingsPanel />);

    const file = new File(["x"], "workspace.jsonl.gz", { type: "application/gzip" });
    const input = await screen.findByLabelText("取り込むファイル");
    await user.upload(input, file);
    await user.click(screen.getByRole("button", { name: "内容を確認" }));
    expect(await screen.findByText("センサー: 1 件")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /通知設定も移す/ }));

    expect(screen.queryByText("センサー: 1 件")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "この内容で取り込む" })).not.toBeInTheDocument();
  });
});
