import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { Plugin } from "../../types";
import { PluginSettingsPanel } from "./PluginSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchPlugins: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
  updatePluginConfig: vi.fn(),
}));

import * as api from "../../lib/api";

const enabledPlugin: Plugin = {
  id: "p1",
  name: "temperature-plugin",
  version: "1.0.0",
  enabled: true,
  installedAt: "2024-01-01T00:00:00.000Z",
  config: { threshold: 30 },
};

const disabledPlugin: Plugin = {
  ...enabledPlugin,
  id: "p2",
  name: "pressure-plugin",
  enabled: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PluginSettingsPanel", () => {
  it("プラグイン一覧を表示する", async () => {
    vi.mocked(api.fetchPlugins).mockResolvedValue([enabledPlugin, disabledPlugin]);

    renderWithQueryClient(<PluginSettingsPanel />);

    expect(await screen.findByText("temperature-plugin")).toBeInTheDocument();
    expect(screen.getByText("pressure-plugin")).toBeInTheDocument();
    expect(screen.getAllByText("v1.0.0")).toHaveLength(2);
  });

  it("プラグインが0件のときメッセージを表示する", async () => {
    vi.mocked(api.fetchPlugins).mockResolvedValue([]);

    renderWithQueryClient(<PluginSettingsPanel />);

    expect(await screen.findByText(/プラグインが見つかりません/)).toBeInTheDocument();
  });

  it("有効なプラグインは「有効」ボタンを表示する", async () => {
    vi.mocked(api.fetchPlugins).mockResolvedValue([enabledPlugin]);

    renderWithQueryClient(<PluginSettingsPanel />);

    await screen.findByText("temperature-plugin");
    expect(screen.getByRole("button", { name: "有効" })).toBeInTheDocument();
  });

  it("有効ボタンを押すとdisablePluginを呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPlugins).mockResolvedValue([enabledPlugin]);
    vi.mocked(api.disablePlugin).mockResolvedValue({ ...enabledPlugin, enabled: false });

    renderWithQueryClient(<PluginSettingsPanel />);

    await screen.findByText("temperature-plugin");
    await user.click(screen.getByRole("button", { name: "有効" }));

    await waitFor(() => expect(api.disablePlugin).toHaveBeenCalledWith("temperature-plugin"));
  });

  it("設定ボタンを押すとConfigEditorが開く", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPlugins).mockResolvedValue([enabledPlugin]);

    renderWithQueryClient(<PluginSettingsPanel />);

    await screen.findByText("temperature-plugin");
    await user.click(screen.getByRole("button", { name: "設定" }));

    expect(screen.getByRole("button", { name: "設定を保存" })).toBeInTheDocument();
  });

  it("不正なJSONをConfigEditorで保存するとエラーを表示する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPlugins).mockResolvedValue([enabledPlugin]);

    renderWithQueryClient(<PluginSettingsPanel />);

    await screen.findByText("temperature-plugin");
    await user.click(screen.getByRole("button", { name: "設定" }));

    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "not-valid-json");
    await user.click(screen.getByRole("button", { name: "設定を保存" }));

    expect(screen.getByText("JSONとして解析できません")).toBeInTheDocument();
  });
});
