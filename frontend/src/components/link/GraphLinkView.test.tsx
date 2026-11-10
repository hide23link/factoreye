import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/errors";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { useUiStore } from "../../store/useUiStore";
import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { DashboardDetail, Sensor, Widget } from "../../types";
import { DashboardListPage } from "../DashboardListPage";
import { GraphLinkView } from "./GraphLinkView";

vi.mock("../../lib/api", () => ({
  fetchDashboard: vi.fn(),
  fetchDashboards: vi.fn(),
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  createDashboard: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor = { id: "s1", name: "乾燥炉 温度", unit: "℃" } as Sensor;

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: "s1",
    type: "SensorGraph",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 6,
    config: { title: "炉の温度" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDashboard(widgets: Widget[]): DashboardDetail {
  return {
    id: "d1",
    name: "ライン1",
    description: null,
    layoutConfig: {},
    widgets,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

const link = { dashboardId: "d1", graphId: "w1", rangeMinutes: 30 };
const initialUi = useUiStore.getState();

beforeEach(() => {
  window.history.replaceState(null, "", "/?dashboard=d1&graph=w1&range=30m");
  useUiStore.setState({ graphLink: link, linkNotFound: false });
  vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
  vi.mocked(api.fetchDashboards).mockResolvedValue([]);
  vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
    bucketSeconds: 60,
    buckets: [{ start: new Date(Date.now() - 60_000).toISOString(), avg: 23.4, min: 23, max: 24, count: 1 }],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.setState(initialUi, true);
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("GraphLinkView", () => {
  it("グラフの名前・リンクの期間・今の値を出す", async () => {
    vi.mocked(api.fetchDashboard).mockResolvedValue(makeDashboard([makeWidget()]));
    renderWithQueryClient(<GraphLinkView link={link} />);

    expect(await screen.findByText("炉の温度")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "時刻を指定" })).toHaveTextContent("直近 30 分");
    expect(await screen.findByText("23.4")).toBeInTheDocument();
    expect(screen.getByText(/自動で更新中/)).toBeInTheDocument();
    // リンクの設定のままなので「今に戻る」は出ない
    expect(screen.queryByRole("button", { name: "今に戻る" })).not.toBeInTheDocument();
  });

  it("端末に覚えたダッシュボードの期間（localStorage）では上書きせず、リンクの期間で開く", async () => {
    localStorage.setItem("factoreye_time_range", JSON.stringify({ mode: "relative", durationMs: 86_400_000 }));
    vi.mocked(api.fetchDashboard).mockResolvedValue(makeDashboard([makeWidget()]));
    renderWithQueryClient(<GraphLinkView link={link} />);

    expect(await screen.findByRole("button", { name: "時刻を指定" })).toHaveTextContent("直近 30 分");
  });

  it("期間のボタンで変えた期間は保存しない（localStorage・URL・ダッシュボードの期間はそのまま）。「今に戻る」でリンクの設定に戻す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboard).mockResolvedValue(makeDashboard([makeWidget()]));
    const rangeBefore = useTimeRangeStore.getState().range;
    renderWithQueryClient(<GraphLinkView link={link} />);

    await user.click(await screen.findByRole("button", { name: "3 時間" }));
    expect(screen.getByRole("button", { name: "時刻を指定" })).toHaveTextContent("直近 3 時間");
    expect(localStorage.getItem("factoreye_time_range")).toBeNull();
    expect(window.location.search).toBe("?dashboard=d1&graph=w1&range=30m");
    expect(useTimeRangeStore.getState().range).toBe(rangeBefore);

    await user.click(screen.getByRole("button", { name: "今に戻る" }));
    expect(screen.getByRole("button", { name: "時刻を指定" })).toHaveTextContent("直近 30 分");
  });

  it("時刻の指定で未来の時刻を選ぶと「まだ来ていない時刻です」", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDashboard).mockResolvedValue(makeDashboard([makeWidget()]));
    renderWithQueryClient(<GraphLinkView link={link} />);

    await user.click(await screen.findByRole("button", { name: "時刻を指定" }));
    const input = screen.getByLabelText("この時刻から");
    const future = new Date(Date.now() + 2 * 86_400_000);
    const two = (n: number) => String(n).padStart(2, "0");
    await user.clear(input);
    await user.type(input, `${future.getFullYear()}-${two(future.getMonth() + 1)}-${two(future.getDate())}T08:00`);
    await user.click(screen.getByRole("button", { name: "表示" }));

    expect(screen.getByText("まだ来ていない時刻です")).toBeInTheDocument();
  });

  it.each([
    ["ダッシュボードが無い・別のワークスペース（404）", () => vi.mocked(api.fetchDashboard).mockRejectedValue(new ApiError(404, "not found"))],
    ["グラフが消された", () => vi.mocked(api.fetchDashboard).mockResolvedValue(makeDashboard([]))],
    ["グラフではないウィジェット", () => vi.mocked(api.fetchDashboard).mockResolvedValue(makeDashboard([makeWidget({ type: "Gauge" })]))],
  ])("見つからない（%s）: URL のリンクを消して、一覧に黄色の帯を出す", async (_label, arrange) => {
    arrange();
    renderWithQueryClient(<GraphLinkView link={link} />);

    await waitFor(() => expect(useUiStore.getState().linkNotFound).toBe(true));
    expect(useUiStore.getState().graphLink).toBeNull();
    expect(window.location.search).toBe("");

    renderWithQueryClient(<DashboardListPage />);
    expect(screen.getByText("リンクのグラフが見つかりません。消されたか、別のワークスペースのものです。")).toBeInTheDocument();
  });

  it("通信の失敗（500）は「見つからない」にせず、やり直せるようにする", async () => {
    vi.mocked(api.fetchDashboard).mockRejectedValue(new ApiError(500, "error"));
    renderWithQueryClient(<GraphLinkView link={link} />);

    expect(await screen.findByText("ダッシュボードを取得できませんでした。")).toBeInTheDocument();
    expect(useUiStore.getState().linkNotFound).toBe(false);
  });
});
