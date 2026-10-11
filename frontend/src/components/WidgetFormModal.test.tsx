import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import type { DashboardDetail, Sensor, Widget } from "../types";
import { WidgetFormModal } from "./WidgetFormModal";

vi.mock("../lib/api", () => ({
  addWidget: vi.fn(),
  updateWidget: vi.fn(),
  fetchSensors: vi.fn(),
}));

import * as api from "../lib/api";

const dashboard: DashboardDetail = {
  id: "d1",
  name: "D",
  description: null,
  layoutConfig: {},
  widgets: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const sensor = {
  id: "s1",
  name: "圧力計A-1",
  unit: "MPa",
  enabled: true,
} as unknown as Sensor;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WidgetFormModal", () => {
  it("センサーが必要な種類は、センサーを選ぶまで追加できない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.addWidget).mockResolvedValue({} as Widget);
    renderWithQueryClient(<WidgetFormModal dashboard={dashboard} onClose={() => {}} />);

    const add = screen.getByRole("button", { name: "追加" });
    expect(add).toBeDisabled();
    expect(screen.getByText("センサーを選んでください。")).toBeInTheDocument();

    await screen.findByRole("option", { name: "圧力計A-1" });
    await user.selectOptions(screen.getByLabelText("センサー"), "s1");
    expect(add).toBeEnabled();
    await user.click(add);

    await waitFor(() =>
      expect(api.addWidget).toHaveBeenCalledWith("d1", expect.objectContaining({ sensorId: "s1" })),
    );
  });

  it("アラーム一覧はセンサー無しで追加できる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<WidgetFormModal dashboard={dashboard} onClose={() => {}} />);

    await user.selectOptions(screen.getByLabelText("種類"), "AlarmAlert");

    expect(screen.getByRole("button", { name: "追加" })).toBeEnabled();
  });

  it("複数センサー比較は、1つも選ばないと追加できない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<WidgetFormModal dashboard={dashboard} onClose={() => {}} />);

    await user.selectOptions(screen.getByLabelText("種類"), "MultiSensorComparison");
    expect(screen.getByRole("button", { name: "追加" })).toBeDisabled();

    await user.click(await screen.findByLabelText("圧力計A-1"));
    expect(screen.getByRole("button", { name: "追加" })).toBeEnabled();
  });

  it("Stat の時間欄を空にして保存すると、既定の 1 時間で保存する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.addWidget).mockResolvedValue({} as Widget);
    renderWithQueryClient(<WidgetFormModal dashboard={dashboard} onClose={() => {}} />);

    await user.selectOptions(screen.getByLabelText("種類"), "StatValue");
    await screen.findByRole("option", { name: "圧力計A-1" });
    await user.selectOptions(screen.getByLabelText("センサー"), "s1");
    const hours = screen.getByRole("spinbutton", { name: /スパークライン/ });
    await user.clear(hours);
    await user.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() =>
      expect(api.addWidget).toHaveBeenCalledWith(
        "d1",
        expect.objectContaining({ config: expect.objectContaining({ timeRangeHours: 1 }) }),
      ),
    );
  });

  it("保存に失敗したとき、エラーを表示してモーダルを閉じない", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.addWidget).mockRejectedValue(new Error("network"));
    renderWithQueryClient(<WidgetFormModal dashboard={dashboard} onClose={onClose} />);

    await screen.findByRole("option", { name: "圧力計A-1" });
    await user.selectOptions(screen.getByLabelText("センサー"), "s1");
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(await screen.findByText(/ウィジェットの追加に失敗しました/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
