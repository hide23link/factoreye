import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor, within } from "../../test/test-utils";
import type { Sensor } from "../../types";
import { SensorSettingsPanel } from "./SensorSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  createSensor: vi.fn(),
  updateSensor: vi.fn(),
  deleteSensor: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "圧力計A-1",
  ingestKey: "sensor-abc",
  unit: "MPa",
  thresholdMin: null,
  thresholdMax: 10,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SensorSettingsPanel", () => {
  it("センサー一覧を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    expect(await screen.findByText("圧力計A-1")).toBeInTheDocument();
    expect(screen.getByText("sensor-abc")).toBeInTheDocument();
  });

  it("センサーが0件の場合は案内文を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    renderWithQueryClient(<SensorSettingsPanel />);

    expect(await screen.findByText(/まだセンサーが登録されていません/)).toBeInTheDocument();
  });

  it("フォームに入力して追加するとcreateSensorが呼ばれる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.type(screen.getByLabelText("名前"), "圧力計A-1");
    await user.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() =>
      expect(api.createSensor).toHaveBeenCalledWith(
        expect.objectContaining({ name: "圧力計A-1", unit: "°C" }),
      ),
    );
  });

  it("有効/無効トグルをクリックするとupdateSensorが呼ばれる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.updateSensor).mockResolvedValue({ ...sensor, enabled: false });
    renderWithQueryClient(<SensorSettingsPanel />);

    const toggle = await screen.findByRole("button", { name: "有効" });
    await user.click(toggle);

    expect(api.updateSensor).toHaveBeenCalledWith("s1", { enabled: false });
  });

  it("削除は確認ダイアログでOKした場合のみdeleteSensorを呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithQueryClient(<SensorSettingsPanel />);

    const row = (await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement;
    await user.click(within(row).getByText("削除"));
    expect(api.deleteSensor).not.toHaveBeenCalled();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.deleteSensor).mockResolvedValue(undefined);
    await user.click(within(row).getByText("削除"));
    expect(api.deleteSensor).toHaveBeenCalledWith("s1");
  });
});
