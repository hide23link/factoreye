import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { IngestLimitStatus } from "../../lib/adminApi";
import { IngestLimitCard } from "./IngestLimitCard";

vi.mock("../../lib/adminApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/adminApi")>();
  return { ...actual, fetchIngestLimit: vi.fn(), setIngestLimit: vi.fn() };
});

import * as adminApi from "../../lib/adminApi";

const LIMITED: IngestLimitStatus = {
  defaultLimit: "100/minute",
  envOff: false,
  bypassed: false,
  bypassUntil: null,
  setBy: null,
  setAt: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IngestLimitCard", () => {
  it("制限ありのときは既定の制限を表示し、解除ボタンを出す", async () => {
    vi.mocked(adminApi.fetchIngestLimit).mockResolvedValue(LIMITED);
    renderWithQueryClient(<IngestLimitCard token="tok" onAuthError={() => {}} />);

    expect(await screen.findByText("制限あり（既定: 100/minute）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "60 分だけ解除" })).toBeEnabled();
  });

  it("解除中は、解除の期限と解除した管理者を表示し、戻すボタンを出す", async () => {
    vi.mocked(adminApi.fetchIngestLimit).mockResolvedValue({
      ...LIMITED,
      bypassed: true,
      bypassUntil: "2026-10-05T13:00:00Z",
      setBy: "factoreye-admin",
    });
    renderWithQueryClient(<IngestLimitCard token="tok" onAuthError={() => {}} />);

    expect(await screen.findByTestId("ingest-limit-state")).toHaveTextContent(
      "制限を解除中",
    );
    expect(screen.getByTestId("ingest-limit-state")).toHaveTextContent("factoreye-admin");
    expect(screen.getByRole("button", { name: "今すぐ制限を戻す" })).toBeEnabled();
  });

  it("環境変数で解除されているときは、ボタンを無効にする", async () => {
    vi.mocked(adminApi.fetchIngestLimit).mockResolvedValue({ ...LIMITED, envOff: true });
    renderWithQueryClient(<IngestLimitCard token="tok" onAuthError={() => {}} />);

    expect(await screen.findByText(/環境変数（INGEST_RATE_LIMIT=off）/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "60 分だけ解除" })).toBeDisabled();
  });

  it("確認で OK を選んだときだけ、60 分の解除を送る", async () => {
    const user = userEvent.setup();
    vi.mocked(adminApi.fetchIngestLimit).mockResolvedValue(LIMITED);
    vi.mocked(adminApi.setIngestLimit).mockResolvedValue({ ...LIMITED, bypassed: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithQueryClient(<IngestLimitCard token="tok" onAuthError={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "60 分だけ解除" }));

    await waitFor(() => expect(adminApi.setIngestLimit).toHaveBeenCalledWith("tok", true));
  });

  it("確認で取り消したときは、何も送らない", async () => {
    const user = userEvent.setup();
    vi.mocked(adminApi.fetchIngestLimit).mockResolvedValue(LIMITED);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithQueryClient(<IngestLimitCard token="tok" onAuthError={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "60 分だけ解除" }));

    expect(adminApi.setIngestLimit).not.toHaveBeenCalled();
  });
});
