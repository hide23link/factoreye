import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { Device, DeviceCreated, Sensor } from "../../types";
import { DevicesSettingsPanel } from "./DevicesSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchDevices: vi.fn(),
  fetchSensors: vi.fn(),
  createDevice: vi.fn(),
  attachDeviceSensors: vi.fn(),
  revokeDevice: vi.fn(),
}));

import * as api from "../../lib/api";

const device: Device = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "atom01",
  line: null,
  createdAt: "2026-11-02T00:57:00Z",
  revokedAt: null,
  lastReceivedAt: "2026-11-02T01:23:00Z", // 日本時間 10:23
  sensors: ["atom01-temp"],
};

const looseSensor = { id: "s1", name: "ld01-v", ingestKey: "ld01-v", deviceId: null } as Sensor;

afterEach(() => {
  vi.restoreAllMocks();
});

function mockLists(devices: Device[], sensors: Sensor[] = []) {
  vi.mocked(api.fetchDevices).mockResolvedValue(devices);
  vi.mocked(api.fetchSensors).mockResolvedValue(sensors);
}

describe("DevicesSettingsPanel", () => {
  it("機器の一覧と、選んだ機器の詳細（日本時間の最後の受信・所属センサー）を出す", async () => {
    mockLists([device]);
    renderWithQueryClient(<DevicesSettingsPanel />);

    expect(await screen.findByRole("option", { name: /atom01/ })).toBeInTheDocument();
    expect(screen.getByText("atom01-temp")).toBeInTheDocument();
    expect(screen.getByText(/10:23/)).toBeInTheDocument();
    expect(screen.getByText(/表示できません/)).toBeInTheDocument();
  });

  it("機器がなければ案内を出す", async () => {
    mockLists([]);
    renderWithQueryClient(<DevicesSettingsPanel />);
    expect(await screen.findByText(/機器がありません/)).toBeInTheDocument();
  });

  it("追加するとキーを 1 回だけ出し、控えたと確認するまで閉じられない", async () => {
    const user = userEvent.setup();
    mockLists([]);
    const created: DeviceCreated = { ...device, key: "secret-key-value-1234567890" };
    vi.mocked(api.createDevice).mockResolvedValue(created);
    renderWithQueryClient(<DevicesSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "機器を追加" }));
    await user.type(screen.getByLabelText("機器名"), "atom01");
    await user.click(screen.getByRole("button", { name: "追加してキーを発行" }));

    expect(vi.mocked(api.createDevice).mock.calls[0][0]).toEqual({ name: "atom01" });
    expect(await screen.findByTestId("device-key")).toHaveTextContent("secret-key-value-1234567890");
    const close = screen.getByRole("button", { name: "閉じる" });
    expect(close).toBeDisabled();
    await user.click(screen.getByLabelText("控えました"));
    await user.click(close);
    expect(screen.queryByTestId("device-key")).not.toBeInTheDocument();
    expect(screen.queryByText("secret-key-value-1234567890")).not.toBeInTheDocument();
  });

  it("同じ名前の機器を追加すると、重複のエラーを出す", async () => {
    const user = userEvent.setup();
    mockLists([]);
    const { ApiError } = await import("../../lib/errors");
    vi.mocked(api.createDevice).mockRejectedValue(new ApiError(409, "dup"));
    renderWithQueryClient(<DevicesSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "機器を追加" }));
    await user.type(screen.getByLabelText("機器名"), "atom01");
    await user.click(screen.getByRole("button", { name: "追加してキーを発行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("すでにある");
  });

  it("未所属のセンサーを選んで所属させる", async () => {
    const user = userEvent.setup();
    mockLists([device], [looseSensor]);
    vi.mocked(api.attachDeviceSensors).mockResolvedValue({ missing: [] });
    renderWithQueryClient(<DevicesSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "所属させる" }));
    await waitFor(() => expect(api.attachDeviceSensors).toHaveBeenCalledWith(device.id, ["ld01-v"]));
  });

  it("見つからないセンサーがあれば、成功とは見せずに知らせる", async () => {
    const user = userEvent.setup();
    mockLists([device], [looseSensor]);
    vi.mocked(api.attachDeviceSensors).mockResolvedValue({ missing: ["ld01-v"] });
    renderWithQueryClient(<DevicesSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "所属させる" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("見つからないセンサー");
  });

  it("キーの小窓は、作成直後の一覧の再取得が失敗しても消えない", async () => {
    const user = userEvent.setup();
    const created: DeviceCreated = { ...device, key: "secret-key-value-1234567890" };
    // 1 回目（最初の表示）は空、作成後の再取得（invalidate）は失敗する
    vi.mocked(api.fetchDevices).mockResolvedValueOnce([]).mockRejectedValue(new Error("network"));
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createDevice).mockResolvedValue(created);
    renderWithQueryClient(<DevicesSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "機器を追加" }));
    await user.type(screen.getByLabelText("機器名"), "atom01");
    await user.click(screen.getByRole("button", { name: "追加してキーを発行" }));

    expect(await screen.findByTestId("device-key")).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.fetchDevices).mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByTestId("device-key")).toBeInTheDocument();
  });

  it("失効は確認してから実行する", async () => {
    const user = userEvent.setup();
    mockLists([device]);
    vi.mocked(api.revokeDevice).mockResolvedValue({ ...device, revokedAt: "2026-11-02T02:00:00Z" });
    renderWithQueryClient(<DevicesSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "キーを失効" }));
    expect(api.revokeDevice).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "失効する" }));
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith(device.id));
  });

  it("失効済みの機器には、失効ボタンも所属付けも出さない", async () => {
    mockLists([{ ...device, revokedAt: "2026-11-02T02:00:00Z" }], [looseSensor]);
    renderWithQueryClient(<DevicesSettingsPanel />);

    expect(await screen.findByText(/失効済みです/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "キーを失効" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "所属させる" })).not.toBeInTheDocument();
  });
});
