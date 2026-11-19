import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor, within } from "../test/test-utils";
import type { DashboardDetail, Sensor, Widget } from "../types";
import { useEditorStore } from "../store/useEditorStore";
import { WidgetCard } from "./WidgetCard";

vi.mock("../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  fetchLatestReadings: vi.fn(),
  fetchAlarms: vi.fn(),
}));
// グラフ本体は、この試験では要らない（メニュー・表・CSV だけを見る）
vi.mock("./widgets/SensorGraphWidget", () => ({ SensorGraphWidget: () => <div>グラフ本体</div> }));
vi.mock("./widgets/GaugeWidget", () => ({ GaugeWidget: () => <div>ゲージ本体</div> }));
vi.mock("../lib/csv", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/csv")>()), downloadCsv: vi.fn() }));

import * as api from "../lib/api";
import * as csv from "../lib/csv";

const dashboard: DashboardDetail = {
  id: "d1",
  name: "ダッシュボード",
  description: null,
  layoutConfig: {},
  widgets: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

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
    config: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// 30 区間（1 分ごと）
const buckets = Array.from({ length: 30 }, (_, i) => {
  const start = new Date(Date.UTC(2026, 10, 20, 1, i)).toISOString();
  return { start, avg: i, max: i + 1, min: i - 1, count: 5 };
});

beforeEach(() => {
  useEditorStore.getState().reset();
  vi.mocked(api.fetchSensors).mockResolvedValue([{ id: "s1", name: "温度", unit: "℃" } as Sensor]);
  vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets });
  vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [] } as never);
});

afterEach(() => vi.restoreAllMocks());

describe("WidgetCard の ⋮ メニュー", () => {
  it("グラフ系には出し、ゲージには出さない", async () => {
    renderWithQueryClient(<WidgetCard widget={makeWidget({ type: "Gauge" })} dashboard={dashboard} />);
    await screen.findByText("ゲージ本体");
    expect(screen.queryByRole("button", { name: "ウィジェットのメニュー" })).toBeNull();
  });

  it("開くたびにグラフと同じ取得（500 区間）を取り直し、表は新しい順に 12 行・「もっと見る」で増える", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);
    await screen.findByText("グラフ本体");

    await user.click(screen.getByRole("button", { name: "ウィジェットのメニュー" }));
    await user.click(screen.getByRole("menuitem", { name: /データを表で見る/ }));

    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(13)); // 見出し + 12 行
    expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalledWith("s1", expect.any(String), expect.any(String), 500);
    // 新しい順: 先頭の行が最後の区間（29）
    expect(within(within(table).getAllByRole("row")[1]).getAllByRole("cell")[1]).toHaveTextContent("29");
    expect(screen.getByText("30 行")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /もっと見る/ }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(25);
  });

  it("「CSV を保存」で、行数が点の数と一致する CSV をファイル名つきで保存する", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetCard widget={makeWidget({ config: { title: "温度 グラフ" } })} dashboard={dashboard} />);
    await screen.findByText("グラフ本体");

    await user.click(screen.getByRole("button", { name: "ウィジェットのメニュー" }));
    // 取得が終わるまで押せない
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /CSV を保存/ })).not.toHaveAttribute("aria-disabled"));
    await user.click(screen.getByRole("menuitem", { name: /CSV を保存/ }));

    expect(csv.downloadCsv).toHaveBeenCalledTimes(1);
    const [fileName, text] = vi.mocked(csv.downloadCsv).mock.calls[0];
    expect(fileName).toBe("温度 グラフ_直近1時間.csv");
    const lines = text.replace("﻿", "").trimEnd().split("\r\n");
    // 見出しにカンマがあるので、CSV の決まりで引用符に囲まれる
    expect(lines[0]).toBe(`"時刻(JST,ISO 8601)",温度 (℃)`);
    expect(lines).toHaveLength(1 + buckets.length);
    expect(lines[1]).toBe("2026-11-20T10:00:00+09:00,0");
  });

  it("「全画面で見る」で重ねて出し、Esc で戻る", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);
    await screen.findByText("グラフ本体");

    await user.click(screen.getByRole("button", { name: "ウィジェットのメニュー" }));
    await user.click(screen.getByRole("menuitem", { name: /全画面で見る/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("グラフ本体")).toBeInTheDocument();
    // 本体は 1 つだけ（裏のカードは描かない）
    expect(screen.getAllByText("グラフ本体")).toHaveLength(1);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("グラフ本体")).toBeInTheDocument();
    // フォーカスは ⋮ のボタンに戻る
    expect(screen.getByRole("button", { name: "ウィジェットのメニュー" })).toHaveFocus();
  });

  it("10 秒以内に開き直したときは取得を使い回し、ゲージのカードは何も取得しない", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);
    await screen.findByText("グラフ本体");
    await user.click(screen.getByRole("button", { name: "ウィジェットのメニュー" }));
    await waitFor(() => expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "ウィジェットのメニュー" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalledTimes(1);
  });

  it("ゲージのカードは、センサーの一覧も取得しない", async () => {
    renderWithQueryClient(<WidgetCard widget={makeWidget({ type: "Gauge" })} dashboard={dashboard} />);
    await screen.findByText("ゲージ本体");
    expect(api.fetchSensors).not.toHaveBeenCalled();
  });

  it("「この期間のリンクをコピー」で、グラフを開くリンクをコピーする", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WidgetCard widget={makeWidget({ id: "9d414f2a-0000-4000-8000-000000000001" })} dashboard={{ ...dashboard, id: "3f8c0000-0000-4000-8000-000000000002" }} />);
    await screen.findByText("グラフ本体");

    await user.click(screen.getByRole("button", { name: "ウィジェットのメニュー" }));
    await user.click(screen.getByRole("menuitem", { name: /この期間のリンクをコピー/ }));
    await screen.findByText("コピーしました");
    await expect(navigator.clipboard.readText()).resolves.toContain("?dashboard=3f8c0000-0000-4000-8000-000000000002&graph=9d414f2a-0000-4000-8000-000000000001&range=60m");
  });

  it("編集中も、歯車・複製・削除と並んで ⋮ が出る", async () => {
    useEditorStore.getState().startEditing();
    renderWithQueryClient(<WidgetCard widget={makeWidget()} dashboard={dashboard} />);
    await screen.findByText("グラフ本体");
    expect(screen.getByRole("button", { name: "ウィジェットのメニュー" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ウィジェットの設定" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ウィジェットを複製" })).toBeInTheDocument();
  });
});
