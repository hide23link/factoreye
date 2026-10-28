import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor, within } from "../../test/test-utils";
import type { FailbackResult, R2Status } from "../../lib/adminApi";
import { R2RestoreCard } from "./R2RestoreCard";

vi.mock("../../lib/adminApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/adminApi")>();
  return {
    ...actual,
    fetchR2Status: vi.fn(),
    startR2Restore: vi.fn(),
    resetR2Restore: vi.fn(),
    previewR2Failback: vi.fn(),
    applyR2Failback: vi.fn(),
    fetchFailbackHandoffs: vi.fn(),
  };
});

import * as adminApi from "../../lib/adminApi";

const HANDOFF = "handoff-factoreye-20261028-103000.sql.gz";
const INFO = {
  baseName: "base_000000010000000000000002",
  baseTime: "2026-10-28T03:00:00Z",
  walLastTime: "2026-10-28T09:59:00Z",
  alembic: "d4e5f6a7b8c9",
  latestReading: "2026-10-28T09:58:30Z",
};
const IDLE: R2Status = { configured: true, state: "idle", message: null, info: null };
const READY: R2Status = { configured: true, state: "ready", message: null, info: INFO };
const PREVIEW: FailbackResult = {
  name: "r2",
  applied: false,
  totalInserted: 9,
  snapshot: null,
  parts: [],
  r2: INFO,
  tables: [
    { table: "users", source: 2, inserted: 2, existing: 0, note: null, closed: 0 },
    { table: "readings", source: 7, inserted: 7, existing: 0, note: null, closed: 0 },
  ],
};

function apiError(status: number, detail: unknown): adminApi.AdminApiError {
  return new adminApi.AdminApiError(status, `failed ${status}`, JSON.stringify({ detail }));
}

function setup(status: R2Status) {
  vi.mocked(adminApi.fetchR2Status).mockResolvedValue(status);
  vi.mocked(adminApi.fetchFailbackHandoffs).mockResolvedValue({
    source: "x",
    items: [
      {
        name: HANDOFF, size: 1, modified: "2026-10-28T10:30:00Z", kind: "reduced",
        watermark: null, alembic: null, instance: null, region: null, createdAt: null,
      },
    ],
  });
  renderWithQueryClient(<R2RestoreCard token="tok" onAuthError={() => {}} />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R2RestoreCard", () => {
  it("設定が無いときは、その旨を出す", async () => {
    setup({ configured: false, state: "idle", message: null, info: null });
    expect(await screen.findByText(/R2 からの復旧は設定されていません/)).toBeInTheDocument();
  });

  it("復元の途中は状態を出し、始めるボタンを押せない", async () => {
    setup({ ...IDLE, state: "replaying" });
    expect(await screen.findByTestId("r2-state")).toHaveTextContent("再生中");
    expect(screen.getByRole("button", { name: "R2 の最新から復元する" })).toBeDisabled();
  });

  it("復元を始める", async () => {
    const user = userEvent.setup();
    setup(IDLE);
    vi.mocked(adminApi.startR2Restore).mockResolvedValue({ ...IDLE, state: "fetching" });

    await user.click(await screen.findByRole("button", { name: "R2 の最新から復元する" }));

    await waitFor(() => expect(adminApi.startR2Restore).toHaveBeenCalledWith("tok"));
    expect(await screen.findByTestId("r2-state")).toHaveTextContent("取得中");
  });

  it("準備完了では、バックアップの内容（ベース・WAL の最終時刻・版）を出す", async () => {
    setup(READY);
    const info = await screen.findByTestId("r2-info");
    expect(info).toHaveTextContent("base_000000010000000000000002");
    expect(info).toHaveTextContent("d4e5f6a7b8c9");
  });

  it("失敗したときは理由を出し、やり直せる", async () => {
    setup({ ...IDLE, state: "failed", message: "R2 にバックアップがありません" });
    expect(await screen.findByRole("alert")).toHaveTextContent("R2 にバックアップがありません");
    expect(screen.getByRole("button", { name: "もう一度、R2 から復元する" })).toBeEnabled();
  });

  it("試算 → 確認 → 実行 → 結果。引き継ぎも合わせると、その名前で試算・実行する", async () => {
    const user = userEvent.setup();
    setup(READY);
    vi.mocked(adminApi.previewR2Failback).mockResolvedValue(PREVIEW);
    vi.mocked(adminApi.applyR2Failback).mockResolvedValue({
      ...PREVIEW, applied: true, snapshot: "before-merge-20261028-110000.sql.gz",
    });

    await user.click(await screen.findByLabelText("引き継ぎ（控えの増加分）も合わせる"));
    await user.click(screen.getByRole("button", { name: "試算する" }));
    await waitFor(() => expect(adminApi.previewR2Failback).toHaveBeenCalledWith("tok", HANDOFF));
    expect(await screen.findByTestId("r2-preview")).toHaveTextContent("9 行が足されます");
    expect(adminApi.applyR2Failback).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "本番に書き戻す" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("復活します");
    await user.click(within(dialog).getByRole("button", { name: "書き戻す" }));

    await waitFor(() => expect(adminApi.applyR2Failback).toHaveBeenCalledWith("tok", HANDOFF, 9));
    expect(await screen.findByTestId("r2-applied")).toHaveTextContent("9 行を足しました");
  });

  it("R2 だけのときは、引き継ぎを指定しない", async () => {
    const user = userEvent.setup();
    setup(READY);
    vi.mocked(adminApi.previewR2Failback).mockResolvedValue(PREVIEW);
    await user.click(await screen.findByRole("button", { name: "試算する" }));
    await waitFor(() => expect(adminApi.previewR2Failback).toHaveBeenCalledWith("tok", null));
  });

  it("版が違うときは、拒否の理由（版が2つ）を出し、実行できない", async () => {
    const user = userEvent.setup();
    setup(READY);
    vi.mocked(adminApi.previewR2Failback).mockRejectedValue(
      apiError(409, { code: "schema_mismatch", message: "スキーマの版が違います（バックアップ aaa / 今 bbb）。" }),
    );
    await user.click(await screen.findByRole("button", { name: "試算する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("バックアップ aaa / 今 bbb");
    expect(screen.queryByRole("button", { name: "本番に書き戻す" })).toBeNull();
  });

  it("時間切れ（504）では完了の確かめ方を案内する", async () => {
    const user = userEvent.setup();
    setup(READY);
    vi.mocked(adminApi.previewR2Failback).mockRejectedValue(apiError(504, "時間切れ"));
    await user.click(await screen.findByRole("button", { name: "試算する" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("追加が 0 件なら");
  });

  it("作業用の復元を消せる", async () => {
    const user = userEvent.setup();
    setup(READY);
    vi.mocked(adminApi.resetR2Restore).mockResolvedValue(IDLE);
    await user.click(await screen.findByRole("button", { name: "作業用の復元を消す" }));
    await waitFor(() => expect(adminApi.resetR2Restore).toHaveBeenCalledWith("tok"));
    expect(await screen.findByTestId("r2-state")).toHaveTextContent("未開始");
  });

  it("管理者トークンが失効したら再ログインへ戻す", async () => {
    const onAuthError = vi.fn();
    vi.mocked(adminApi.fetchR2Status).mockRejectedValue(apiError(401, "x"));
    vi.mocked(adminApi.fetchFailbackHandoffs).mockResolvedValue({ source: "", items: [] });
    renderWithQueryClient(<R2RestoreCard token="tok" onAuthError={onAuthError} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalled());
  });
});
