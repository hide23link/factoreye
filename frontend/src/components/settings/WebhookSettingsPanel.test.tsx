import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { WebhookSubscription } from "../../types";
import { WebhookSettingsPanel } from "./WebhookSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchWebhookSubscriptions: vi.fn(),
  createWebhookSubscription: vi.fn(),
  updateWebhookSubscription: vi.fn(),
  deleteWebhookSubscription: vi.fn(),
}));

import * as api from "../../lib/api";

const webhook: WebhookSubscription = {
  id: "11111111-1111-1111-1111-111111111111",
  eventType: "reading.received",
  url: "https://hooks.example.com/abc",
  enabled: true,
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebhookSettingsPanel", () => {
  it("登録済みのWebhookを一覧表示する", async () => {
    vi.mocked(api.fetchWebhookSubscriptions).mockResolvedValue([webhook]);
    renderWithQueryClient(<WebhookSettingsPanel />);

    expect(await screen.findByText(webhook.url)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "有効" })).toBeInTheDocument();
  });

  it("新規追加フォームでcreateWebhookSubscriptionが呼ばれる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchWebhookSubscriptions).mockResolvedValue([]);
    vi.mocked(api.createWebhookSubscription).mockResolvedValue(webhook);
    renderWithQueryClient(<WebhookSettingsPanel />);

    await user.type(
      await screen.findByPlaceholderText("https://hooks.zapier.com/..."),
      webhook.url,
    );
    await user.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() =>
      expect(api.createWebhookSubscription).toHaveBeenCalledWith({
        eventType: "reading.received",
        url: webhook.url,
      }),
    );
  });

  it("有効/無効の切り替えでupdateWebhookSubscriptionが呼ばれる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchWebhookSubscriptions).mockResolvedValue([webhook]);
    vi.mocked(api.updateWebhookSubscription).mockResolvedValue({
      ...webhook,
      enabled: false,
    });
    renderWithQueryClient(<WebhookSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "有効" }));

    await waitFor(() =>
      expect(api.updateWebhookSubscription).toHaveBeenCalledWith(webhook.id, {
        enabled: false,
      }),
    );
  });

  it("削除ボタンでdeleteWebhookSubscriptionが呼ばれる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchWebhookSubscriptions).mockResolvedValue([webhook]);
    vi.mocked(api.deleteWebhookSubscription).mockResolvedValue(undefined);
    renderWithQueryClient(<WebhookSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "削除" }));

    await waitFor(() => expect(api.deleteWebhookSubscription).toHaveBeenCalledWith(webhook.id));
  });
});
