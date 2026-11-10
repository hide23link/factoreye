import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { DashboardDetail, Sensor, Widget } from "../../types";
import { GraphLinkDialog } from "./GraphLinkDialog";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

import * as api from "../../lib/api";

function makeWidget(id: string, overrides: Partial<Widget> = {}): Widget {
  return {
    id,
    dashboardId: "d1",
    sensorId: "s1",
    type: "SensorGraph",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 6,
    config: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const dashboard: DashboardDetail = {
  id: "d1",
  name: "ライン1 稼働",
  description: null,
  layoutConfig: {},
  widgets: [
    makeWidget("w1", { config: { title: "温度・湿度" } }),
    makeWidget("gauge", { type: "Gauge", config: { title: "メーター" } }),
    makeWidget("w2", { config: { title: "ショット数" } }),
  ],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const linkText = () => screen.getByText(/\?dashboard=/).textContent;

beforeEach(() => {
  vi.mocked(api.fetchSensors).mockResolvedValue([{ id: "s1", name: "温度", unit: "℃" } as Sensor]);
  vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GraphLinkDialog", () => {
  it("グラフのウィジェットだけを選べ、既定は先頭のグラフ・直近 30 分", () => {
    renderWithQueryClient(<GraphLinkDialog dashboard={dashboard} onClose={() => {}} />);

    expect(screen.getByRole("heading", { name: "リンクを作る（ライン1 稼働）" })).toBeInTheDocument();
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["温度・湿度", "ショット数"]);
    expect(linkText()).toBe(`${window.location.origin}/?dashboard=d1&graph=w1&range=30m`);
  });

  it("グラフ・直近のボタン・ほかの分数で、リンクの URL を組み立てる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<GraphLinkDialog dashboard={dashboard} onClose={() => {}} />);

    await user.selectOptions(screen.getByRole("combobox"), "w2");
    await user.click(screen.getByRole("button", { name: "3 時間" }));
    expect(linkText()).toBe(`${window.location.origin}/?dashboard=d1&graph=w2&range=180m`);

    const minutes = screen.getByLabelText("ほかの分数");
    await user.clear(minutes);
    await user.type(minutes, "45");
    expect(linkText()).toMatch(/range=45m$/);
    // 範囲の外（10 分未満）は使わない
    await user.clear(minutes);
    await user.type(minutes, "5");
    expect(linkText()).toMatch(/range=45m$/);
  });

  it("「コピー」でリンクをコピーし、「コピーしました」を出す", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<GraphLinkDialog dashboard={dashboard} onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "コピー" }));
    expect(await screen.findByText("コピーしました")).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(`${window.location.origin}/?dashboard=d1&graph=w1&range=30m`);
  });

  it("「閉じる」・Esc で閉じる", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithQueryClient(<GraphLinkDialog dashboard={dashboard} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "閉じる" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
