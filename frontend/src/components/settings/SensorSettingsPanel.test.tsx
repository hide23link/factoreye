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
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: 10,
  thresholdDeadBand: 0,
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

  it("Free Tier 上限（402）に達すると上限の案内を表示する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createSensor).mockRejectedValue(
      new Error('POST /api/sensors failed: 402 {"detail":"free tier limit reached (10 sensors)"}'),
    );
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.type(screen.getByLabelText("名前"), "圧力計A-1");
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(await screen.findByText(/センサー上限（10個）に達しました/)).toBeInTheDocument();
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

  it("作成フォームの単位は、プルダウンで候補をすべて選べる（°C 以外も選べる）", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    const select = screen.getByRole("combobox", { name: "単位" });
    expect(within(select).getAllByRole("option").length).toBeGreaterThan(20);
    await user.type(screen.getByLabelText("名前"), "圧力計A-1");
    await user.selectOptions(select, "MPa");
    await user.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() => expect(api.createSensor).toHaveBeenCalledWith(expect.objectContaining({ unit: "MPa" })));
  });

  it("候補にない既存の単位（ppm）は、編集しても消えず、そのまま保存できる", async () => {
    const user = userEvent.setup();
    const odd = { ...sensor, unit: "ppm" };
    vi.mocked(api.fetchSensors).mockResolvedValue([odd]);
    vi.mocked(api.updateSensor).mockResolvedValue(odd);
    renderWithQueryClient(<SensorSettingsPanel />);

    const row = (await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement;
    await user.click(within(row).getByText("編集"));
    expect(screen.getByRole("textbox", { name: "単位（自由入力）" })).toHaveValue("ppm");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.updateSensor).toHaveBeenCalledWith("s1", expect.objectContaining({ unit: "ppm" })));
  });
});
