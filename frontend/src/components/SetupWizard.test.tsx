import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import type { Sensor } from "../types";
import { SetupWizard } from "./SetupWizard";

vi.mock("../lib/api", () => ({
  fetchSensorReadings: vi.fn(),
  fetchSensors: vi.fn(),
  createSensor: vi.fn(),
  createDashboard: vi.fn(),
  addWidget: vi.fn(),
}));

import * as api from "../lib/api";

const newSensor: Sensor = {
  id: "s-new",
  name: "デモセンサー",
  ingestKey: "demo-sensor-xyz",
  unit: "C",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: null,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SetupWizard", () => {
  it("ステップ1のフォームを表示する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });

    renderWithQueryClient(<SetupWizard />);

    expect(screen.getByText("セットアップガイド")).toBeInTheDocument();
    expect(screen.getByText("センサー登録")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "次へ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "スキップしてダッシュボード一覧へ" })).toBeInTheDocument();
  });

  it("フォーム送信でcreateSensorを呼んでステップ2へ進む", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.createSensor).mockResolvedValue(newSensor);

    renderWithQueryClient(<SetupWizard />);

    const nameInput = screen.getByRole("textbox", { name: /名前/ });
    await user.clear(nameInput);
    await user.type(nameInput, "テスト温度計");

    await user.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(api.createSensor).toHaveBeenCalled());
    expect(await screen.findByText(/テストデータを送ってみましょう/)).toBeInTheDocument();
  });

  it("APIエラー時にエラーメッセージを表示する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.createSensor).mockRejectedValue(new Error("409 conflict"));

    renderWithQueryClient(<SetupWizard />);

    await user.click(screen.getByRole("button", { name: "次へ" }));

    expect(
      await screen.findByText("その名前またはIngest Keyは既に使われています。別の値に変更して再試行してください。"),
    ).toBeInTheDocument();
  });

  it("ステップ2でコードタブを切り替えられる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
    vi.mocked(api.createSensor).mockResolvedValue(newSensor);

    renderWithQueryClient(<SetupWizard />);

    await user.click(screen.getByRole("button", { name: "次へ" }));
    await screen.findByText(/テストデータを送ってみましょう/);

    await user.click(screen.getByRole("button", { name: "Python (Raspberry Pi)" }));
    expect(screen.getByText(/factoreye_client/)).toBeInTheDocument();
  });
});
