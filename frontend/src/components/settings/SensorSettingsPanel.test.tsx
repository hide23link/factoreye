import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fireEvent, renderWithQueryClient, screen, waitFor, within } from "../../test/test-utils";
import { ApiError } from "../../lib/errors";
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

  it("削除は確認ダイアログで「削除」を押した場合のみ deleteSensor を呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.deleteSensor).mockResolvedValue(undefined);
    renderWithQueryClient(<SensorSettingsPanel />);

    const row = (await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement;
    await user.click(within(row).getByText("削除"));
    expect(api.deleteSensor).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("元に戻せません");

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "キャンセル" }));
    expect(api.deleteSensor).not.toHaveBeenCalled();

    await user.click(within(row).getByText("削除"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "削除" }));
    expect(api.deleteSensor).toHaveBeenCalledWith("s1");
  });

  it("未入力のまま追加を押すと、理由を表示する（黙って何も起きない状態にしない）", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByRole("alert")).toHaveTextContent("名前を入力してください");
    expect(api.createSensor).not.toHaveBeenCalled();
  });

  it("編集: 名前を空にして保存しようとすると理由を出し、保存しない。Enter で保存、Esc でキャンセルできる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.updateSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    const row = (await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement;
    await user.click(within(row).getByText("編集"));
    const name = screen.getByRole("textbox", { name: "センサー名" });
    await user.clear(name);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("名前を入力してください");
    expect(api.updateSensor).not.toHaveBeenCalled();

    await user.type(name, "圧力計B");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.updateSensor).toHaveBeenCalledWith("s1", expect.objectContaining({ name: "圧力計B" })));
  });

  it("編集: しきい値の大小が逆だと保存せず、理由を出す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    const row = (await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement;
    await user.click(within(row).getByText("編集"));
    await user.type(screen.getByRole("spinbutton", { name: "軽故障の上限" }), "20"); // 重故障の上限は 10
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByRole("alert")).toHaveTextContent("しきい値の大小");
    expect(api.updateSensor).not.toHaveBeenCalled();
  });

  it("保存の失敗（409・500）は、API の生のメッセージではなく日本語で出す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.updateSensor).mockRejectedValue(new ApiError(500, "PUT /api/sensors/s1 failed: 500 Traceback"));
    renderWithQueryClient(<SensorSettingsPanel />);

    const row = (await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement;
    await user.click(within(row).getByText("編集"));
    await user.click(screen.getByRole("button", { name: "保存" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("センサーの保存に失敗しました");
    expect(alert).not.toHaveTextContent("Traceback");
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

  it("候補にない既存の単位（psi）は、編集しても消えず、そのまま保存できる", async () => {
    const user = userEvent.setup();
    const odd = { ...sensor, unit: "psi" };
    vi.mocked(api.fetchSensors).mockResolvedValue([odd]);
    vi.mocked(api.updateSensor).mockResolvedValue(odd);
    renderWithQueryClient(<SensorSettingsPanel />);

    const row = (await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement;
    await user.click(within(row).getByText("編集"));
    expect(screen.getByRole("textbox", { name: "単位（自由入力）" })).toHaveValue("psi");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.updateSensor).toHaveBeenCalledWith("s1", expect.objectContaining({ unit: "psi" })));
  });

  it("名前・単位の前後の空白は、送る前に取り除く", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.type(screen.getByLabelText("名前"), "  圧力計A-1  ");
    await user.selectOptions(screen.getByRole("combobox", { name: "単位" }), "その他（自由入力）");
    await user.type(screen.getByRole("textbox", { name: "単位（自由入力）" }), " psi ");
    await user.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() => expect(api.createSensor).toHaveBeenCalledWith(expect.objectContaining({ name: "圧力計A-1", unit: "psi" })));
  });

  it("編集: 日本語入力の変換確定の Enter では保存しない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.updateSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    const row = (await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement;
    await user.click(within(row).getByText("編集"));
    const name = screen.getByRole("textbox", { name: "センサー名" });

    fireEvent.keyDown(name, { key: "Enter", isComposing: true });
    fireEvent.keyDown(name, { key: "Enter", keyCode: 229 });
    expect(api.updateSensor).not.toHaveBeenCalled();

    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(api.updateSensor).toHaveBeenCalled());
  });

  it("編集: Esc でキャンセルすると、入力途中の値を捨てて元の値に戻る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    const row = (await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement;
    await user.click(within(row).getByText("編集"));
    const name = screen.getByRole("textbox", { name: "センサー名" });
    await user.clear(name);
    await user.type(name, "途中の名前");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "センサー名" })).not.toBeInTheDocument();

    await user.click(within((await screen.findByText("圧力計A-1")).closest("tr") as HTMLElement).getByText("編集"));
    expect(screen.getByRole("textbox", { name: "センサー名" })).toHaveValue("圧力計A-1");
  });
});
