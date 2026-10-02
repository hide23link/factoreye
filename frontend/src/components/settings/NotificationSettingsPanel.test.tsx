import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { NotificationSettings } from "../../types";
import { NotificationSettingsPanel } from "./NotificationSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
}));

import * as api from "../../lib/api";

const settings: NotificationSettings = {
  discordWebhookUrlCritical: "https://discord.com/api/webhooks/critical/xxx",
  discordWebhookUrlWarning: "https://discord.com/api/webhooks/warning/yyy",
  enabled: true,
  criticalRepeatEnabled: true,
  criticalRepeatIntervalMinutes: 15,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationSettingsPanel", () => {
  it("取得した設定を入力欄に反映する", async () => {
    vi.mocked(api.fetchNotificationSettings).mockResolvedValue(settings);
    renderWithQueryClient(<NotificationSettingsPanel />);

    expect(
      await screen.findByDisplayValue(settings.discordWebhookUrlCritical),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue(settings.discordWebhookUrlWarning)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "通知を有効にする" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /重故障が解決しないまま/ }),
    ).toBeChecked();
    expect(screen.getByDisplayValue("15")).toBeInTheDocument();
  });

  it("保存ボタンでupdateNotificationSettingsが呼ばれる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchNotificationSettings).mockResolvedValue({
      discordWebhookUrlCritical: "",
      discordWebhookUrlWarning: "",
      enabled: true,
      criticalRepeatEnabled: false,
      criticalRepeatIntervalMinutes: 30,
    });
    vi.mocked(api.updateNotificationSettings).mockResolvedValue(settings);
    renderWithQueryClient(<NotificationSettingsPanel />);

    const inputs = await screen.findAllByPlaceholderText(
      "https://discord.com/api/webhooks/...",
    );
    await user.type(inputs[0], settings.discordWebhookUrlCritical);
    await user.type(inputs[1], settings.discordWebhookUrlWarning);
    await user.click(screen.getByRole("checkbox", { name: /重故障が解決しないまま/ }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(api.updateNotificationSettings).toHaveBeenCalledWith({
        discordWebhookUrlCritical: settings.discordWebhookUrlCritical,
        discordWebhookUrlWarning: settings.discordWebhookUrlWarning,
        enabled: true,
        criticalRepeatEnabled: true,
        criticalRepeatIntervalMinutes: 30,
      }),
    );
  });
});
