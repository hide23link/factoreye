import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor, within } from "../../test/test-utils";
import type { FailbackHandoffList, FailbackResult } from "../../lib/adminApi";
import { FailbackCard } from "./FailbackCard";

vi.mock("../../lib/adminApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/adminApi")>();
  return { ...actual, fetchFailbackHandoffs: vi.fn(), previewFailback: vi.fn(), applyFailback: vi.fn() };
});

import * as adminApi from "../../lib/adminApi";

const NAME = "handoff-factoreye-20261028-103000.sql.gz";

const LIST: FailbackHandoffList = {
  source: "s3://factoreye-backup/handoff-inc",
  items: [
    {
      name: NAME,
      size: 12288,
      modified: "2026-10-28T10:30:00Z",
      kind: "reduced",
      watermark: "2026-10-05 00:30:00+00",
      alembic: "abc",
      instance: "i-0abc",
      region: "ap-northeast-3",
      createdAt: "2026-10-28T10:30:00Z",
    },
  ],
};

const PREVIEW: FailbackResult = {
  name: NAME,
  applied: false,
  totalInserted: 5,
  snapshot: null,
  parts: [],
  r2: null,
  tables: [
    { table: "readings", source: 4, inserted: 3, existing: 1, note: null, closed: 0 },
    { table: "alarms", source: 3, inserted: 2, existing: 1, note: "発生中のアラーム 1 件を解除済みにして戻します", closed: 1 },
  ],
};

function apiError(status: number, detail: unknown): adminApi.AdminApiError {
  return new adminApi.AdminApiError(status, `failed ${status}`, JSON.stringify({ detail }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function openPreview() {
  const user = userEvent.setup();
  vi.mocked(adminApi.fetchFailbackHandoffs).mockResolvedValue(LIST);
  vi.mocked(adminApi.previewFailback).mockResolvedValue(PREVIEW);
  renderWithQueryClient(<FailbackCard token="tok" onAuthError={() => {}} />);
  await user.click(await screen.findByRole("button", { name: `${NAME} を試算する` }));
  await screen.findByTestId("failback-preview");
  return user;
}

describe("FailbackCard", () => {
  it("引き継ぎの一覧を、名前・種類・起点つきで出す", async () => {
    vi.mocked(adminApi.fetchFailbackHandoffs).mockResolvedValue(LIST);
    renderWithQueryClient(<FailbackCard token="tok" onAuthError={() => {}} />);

    expect(await screen.findByText(NAME)).toBeInTheDocument();
    expect(screen.getByText(/種類: reduced/)).toBeInTheDocument();
    expect(screen.getByText(/起点: 2026-10-05 00:30:00\+00/)).toBeInTheDocument();
    // 制限は、実行の前から見える
    expect(screen.getByText(/パスワードの変更など）は戻りません/)).toBeInTheDocument();
    expect(screen.getByText(/削除したセンサー・ダッシュボード.*復活します/)).toBeInTheDocument();
    expect(screen.getByText(/取り込み（機器からの送信）を止めるか減らして/)).toBeInTheDocument();
  });

  it("時間切れ（504）のときは、完了の確かめ方を案内する", async () => {
    const user = await openPreview();
    vi.mocked(adminApi.applyFailback).mockRejectedValue(
      apiError(504, "復旧ツールの応答がありません（時間切れ）。しばらくしてから確かめてください"),
    );

    await user.click(screen.getByRole("button", { name: "本番に書き戻す" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "書き戻す" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("時間切れ");
    expect(alert).toHaveTextContent("再度試算して、追加が 0 件なら、書き戻しは完了しています");
  });

  it("実行中に何度押しても、実行は 1 回だけ", async () => {
    const user = await openPreview();
    let finish: (r: FailbackResult) => void = () => {};
    vi.mocked(adminApi.applyFailback).mockReturnValue(
      new Promise<FailbackResult>((resolve) => {
        finish = resolve;
      }),
    );

    await user.click(screen.getByRole("button", { name: "本番に書き戻す" }));
    const confirm = within(await screen.findByRole("dialog")).getByRole("button", { name: "書き戻す" });
    await user.click(confirm);
    await user.click(confirm);
    await user.click(confirm);

    expect(adminApi.applyFailback).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    finish({ ...PREVIEW, applied: true, snapshot: "before-merge-x.sql.gz" });
    await screen.findByTestId("failback-applied");
  });

  it("引き継ぎが無いときは、その旨を出す", async () => {
    vi.mocked(adminApi.fetchFailbackHandoffs).mockResolvedValue({ source: "x", items: [] });
    renderWithQueryClient(<FailbackCard token="tok" onAuthError={() => {}} />);

    expect(await screen.findByText(/引き継ぎはありません/)).toBeInTheDocument();
  });

  it("復旧ツールに接続できないときは、サーバーが返した文を出す", async () => {
    vi.mocked(adminApi.fetchFailbackHandoffs).mockRejectedValue(
      apiError(503, "復旧ツールに接続できません。復旧ツール（recovery）が起動しているか確認してください"),
    );
    renderWithQueryClient(<FailbackCard token="tok" onAuthError={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("復旧ツールに接続できません");
  });

  it("試算は件数を出すだけで、実行はしない", async () => {
    await openPreview();

    expect(adminApi.previewFailback).toHaveBeenCalledWith("tok", NAME);
    expect(screen.getByTestId("failback-preview")).toHaveTextContent("5 行が足されます");
    expect(within(screen.getByTestId("failback-tables")).getByText("測定値")).toBeInTheDocument();
    expect(screen.getByText(/発生中のアラーム 1 件を解除済み/)).toBeInTheDocument();
    expect(adminApi.applyFailback).not.toHaveBeenCalled();
  });

  it("確認の小窓で書き戻すを押すと、試算の件数つきで実行し、結果を出す", async () => {
    const user = await openPreview();
    vi.mocked(adminApi.applyFailback).mockResolvedValue({
      ...PREVIEW,
      applied: true,
      snapshot: "before-merge-20261028-110000.sql.gz",
    });

    await user.click(screen.getByRole("button", { name: "本番に書き戻す" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("5 行を本番に足します");
    expect(dialog).toHaveTextContent("戻りません");
    expect(adminApi.applyFailback).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "書き戻す" }));

    await waitFor(() => expect(adminApi.applyFailback).toHaveBeenCalledWith("tok", NAME, 5));
    const done = await screen.findByTestId("failback-applied");
    expect(done).toHaveTextContent("書き戻しました（5 行を足しました）");
    expect(done).toHaveTextContent("before-merge-20261028-110000.sql.gz");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("キャンセルしたときは、何も実行しない", async () => {
    const user = await openPreview();
    await user.click(screen.getByRole("button", { name: "本番に書き戻す" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "キャンセル" }));

    expect(adminApi.applyFailback).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("件数が変わって拒否されたら、理由を出して試算のやり直しを求める", async () => {
    const user = await openPreview();
    vi.mocked(adminApi.applyFailback).mockRejectedValue(
      apiError(409, "試行の後に今の DB が変わりました（確認した 5 行 → 今は 7 行）。もう一度試行してください"),
    );

    await user.click(screen.getByRole("button", { name: "本番に書き戻す" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "書き戻す" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("今の DB が変わりました");
    // 古い試算では、もう実行できない
    expect(screen.queryByRole("button", { name: "本番に書き戻す" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("failback-applied")).not.toBeInTheDocument();
  });

  it("スキーマの版が違うときは、書き戻さずに警告を出す", async () => {
    const user = userEvent.setup();
    vi.mocked(adminApi.fetchFailbackHandoffs).mockResolvedValue(LIST);
    vi.mocked(adminApi.previewFailback).mockRejectedValue(
      apiError(409, { code: "schema_mismatch", message: "スキーマの版が違います（バックアップ aaa / 今 bbb）" }),
    );
    renderWithQueryClient(<FailbackCard token="tok" onAuthError={() => {}} />);

    await user.click(await screen.findByRole("button", { name: `${NAME} を試算する` }));

    expect(await screen.findByRole("alert")).toHaveTextContent("スキーマの版が違います");
    expect(screen.queryByRole("button", { name: "本番に書き戻す" })).not.toBeInTheDocument();
  });

  it("足す行が 0 件のときは、書き戻すボタンを押せない", async () => {
    const user = userEvent.setup();
    vi.mocked(adminApi.fetchFailbackHandoffs).mockResolvedValue(LIST);
    vi.mocked(adminApi.previewFailback).mockResolvedValue({
      ...PREVIEW,
      totalInserted: 0,
      tables: PREVIEW.tables.map((t) => ({ ...t, inserted: 0 })),
    });
    renderWithQueryClient(<FailbackCard token="tok" onAuthError={() => {}} />);

    await user.click(await screen.findByRole("button", { name: `${NAME} を試算する` }));

    expect(await screen.findByRole("button", { name: "本番に書き戻す" })).toBeDisabled();
    expect(screen.getByText("足す行はありません")).toBeInTheDocument();
  });

  it("管理者トークンが失効（401）したら、再ログインへ戻す", async () => {
    const onAuthError = vi.fn();
    vi.mocked(adminApi.fetchFailbackHandoffs).mockRejectedValue(apiError(401, "admin authentication required"));
    renderWithQueryClient(<FailbackCard token="tok" onAuthError={onAuthError} />);

    await waitFor(() => expect(onAuthError).toHaveBeenCalled());
  });
});
