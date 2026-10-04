import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../test/test-utils";
import { SettingsPage } from "./SettingsPage";

vi.mock("../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchAlarms: vi.fn(),
  fetchNotificationSettings: vi.fn(),
  fetchWebhookSubscriptions: vi.fn(),
}));

import * as api from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsPage", () => {
  it("デフォルトはセンサータブを表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);

    renderWithQueryClient(<SettingsPage />);

    expect(screen.getByRole("button", { name: "センサー" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "アラーム" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通知" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Webhook連携" })).toBeInTheDocument();
  });

  it("アラームタブに切り替えられる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchAlarms).mockResolvedValue({ alarms: [], total: 0 });

    renderWithQueryClient(<SettingsPage />);

    await user.click(screen.getByRole("button", { name: "アラーム" }));

    expect(await screen.findByText(/該当するアラームはありません/)).toBeInTheDocument();
  });

  it("通知タブに切り替えられる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchNotificationSettings).mockResolvedValue({
      discordWebhookUrlCritical: "",
      discordWebhookUrlWarning: "",
      enabled: false,
      criticalRepeatEnabled: false,
      criticalRepeatIntervalMinutes: 60,
    });

    renderWithQueryClient(<SettingsPage />);

    await user.click(screen.getByRole("button", { name: "通知" }));

    // NotificationSettingsPanelが描画されていれば静的テキストが表示される
    expect(await screen.findByText("通知", { selector: "h2" })).toBeInTheDocument();
  });

  it("Webhook連携タブに切り替えられる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchWebhookSubscriptions).mockResolvedValue([]);

    renderWithQueryClient(<SettingsPage />);

    await user.click(screen.getByRole("button", { name: "Webhook連携" }));

    // WebhookSettingsPanelが描画されていれば静的見出しが表示される
    expect(await screen.findByText("Webhook連携", { selector: "h2" })).toBeInTheDocument();
  });
});
