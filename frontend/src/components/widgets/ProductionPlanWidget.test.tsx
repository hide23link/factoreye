import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { ProductionPlanWidget } from "./ProductionPlanWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

// 現在時刻は 2024-01-01 13:20（ローカル）に固定する
const NOW = new Date(2024, 0, 1, 13, 20, 0).getTime();
// テストごとに現在時刻を変えられるようにする（vi.mock は先頭に巻き上げられるため、vi.hoisted で値を用意する）
const clock = vi.hoisted(() => ({ hour: 13, minute: 20 }));
vi.mock("../../hooks/useNow", () => ({ useNow: () => new Date(2024, 0, 1, clock.hour, clock.minute, 0).getTime() }));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "ライン1 生産数",
  ingestKey: "line1-count",
  unit: "個",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: null,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "",
  updatedAt: "",
};

function makeWidget(config: Widget["config"] = { dailyTarget: 1200 }, sensorId: string | null = "s1"): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId,
    type: "ProductionPlan",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 9,
    config,
    createdAt: "",
    updatedAt: "",
  };
}

// 8:00 から 13:20 まで、10 分ごとに 1 件 25 個（昼休み 12 時台は無し）
function steadyBuckets() {
  const buckets = [];
  for (let minute = 8 * 60; minute < 13 * 60 + 20; minute += 10) {
    if (minute >= 12 * 60 && minute < 13 * 60) continue;
    buckets.push({
      start: new Date(2024, 0, 1, 0, minute).toISOString(),
      min: 25,
      avg: 25,
      max: 25,
      count: 1,
    });
  }
  return buckets;
}

// jsdom には画面の寸法が無い。はみ出し判定（scrollHeight と clientHeight）を、テストの都合で作る
function stubLayout(contentHeight: (el: HTMLElement) => number, boxHeight: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "production-plan-content" ? contentHeight(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "production-plan-content" ? boxHeight : 0;
  });
}

beforeEach(() => {
  clock.hour = 13;
  clock.minute = 20;
  vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
  vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 600, buckets: steadyBuckets() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProductionPlanWidget", () => {
  it("センサーが無ければ案内を出す", () => {
    renderWithQueryClient(<ProductionPlanWidget widget={makeWidget({ dailyTarget: 1200 }, null)} />);
    expect(screen.getByText("センサーが設定されていません")).toBeInTheDocument();
  });

  it("目標が無ければ、設定を促す", async () => {
    renderWithQueryClient(<ProductionPlanWidget widget={makeWidget({})} />);
    expect(await screen.findByText(/1日の目標が設定されていません/)).toBeInTheDocument();
  });

  it("勤務時間帯を 10 分ごとに分けて取得する（8〜17 時 → 54 区間）", async () => {
    renderWithQueryClient(<ProductionPlanWidget widget={makeWidget()} />);
    await screen.findByText("計画より 0 個 先行");
    expect(api.fetchSensorReadingsDownsampled).toHaveBeenCalledWith(
      "s1",
      new Date(2024, 0, 1, 8).toISOString(),
      new Date(2024, 0, 1, 17).toISOString(),
      54,
    );
    expect(NOW).toBeGreaterThan(0);
  });

  it("実績・達成率・見込み・稼働率・時間別グラフをすべて表示する", async () => {
    renderWithQueryClient(<ProductionPlanWidget widget={makeWidget()} />);
    expect(await screen.findByText(/ライン1 生産数/)).toBeInTheDocument();
    // 26 区間 × 25 = 650 個、目標 1200 → 54%
    expect(screen.getByText("54%")).toBeInTheDocument();
    expect(screen.getByText("終業時の見込み")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument(); // 稼働率
    expect(screen.getByLabelText("時間別の実績と計画")).toBeInTheDocument();
  });

  it("遅れているときは「遅れ」と表示する", async () => {
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 600, buckets: steadyBuckets().slice(0, 10) });
    renderWithQueryClient(<ProductionPlanWidget widget={makeWidget()} />);
    expect(await screen.findByText(/計画より .* 遅れ/)).toBeInTheDocument();
  });

  it("始業直後（稼働 30 分未満）は、見込みを「—」にして赤くしない", async () => {
    clock.hour = 8;
    clock.minute = 20;
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 600, buckets: [] });
    renderWithQueryClient(<ProductionPlanWidget widget={makeWidget()} />);

    const label = await screen.findByText("終業時の見込み");
    const value = label.parentElement!.querySelector("b")!;
    expect(value).toHaveTextContent("—");
    expect(value.className).not.toMatch(/red|amber|green/);
  });

  it("表示項目を OFF にすると、その項目を出さない", async () => {
    renderWithQueryClient(
      <ProductionPlanWidget widget={makeWidget({ dailyTarget: 1200, showHourly: false, showForecast: false, showUptime: false })} />,
    );
    await screen.findByText("54%");
    expect(screen.queryByLabelText("時間別の実績と計画")).not.toBeInTheDocument();
    expect(screen.queryByText("終業時の見込み")).not.toBeInTheDocument();
    expect(screen.queryByText("稼働率")).not.toBeInTheDocument();
  });

  describe("入りきらないとき（狭い幅・低い高さ）", () => {
    it("時間別グラフがあるとはみ出すなら、グラフだけを省き、見込みなどは残す", async () => {
      // グラフがある間だけ内容が高い（箱 300 に対して 500）。グラフが無ければ 200 で収まる
      stubLayout((el) => (el.querySelector('[aria-label="時間別の実績と計画"]') ? 500 : 200), 300);
      renderWithQueryClient(<ProductionPlanWidget widget={makeWidget()} />);

      await screen.findByText("54%");
      expect(screen.queryByLabelText("時間別の実績と計画")).not.toBeInTheDocument();
      expect(screen.getByText("終業時の見込み")).toBeInTheDocument();
      expect(screen.getByText("稼働率")).toBeInTheDocument();
    });

    it("見込みがあるとまだはみ出すなら、見込みも省く（省く順: 時間別 → 見込み → 稼働率）", async () => {
      stubLayout((el) => (el.textContent?.includes("終業時の見込み") ? 500 : 200), 300);
      renderWithQueryClient(<ProductionPlanWidget widget={makeWidget()} />);

      await screen.findByText("54%");
      expect(screen.queryByLabelText("時間別の実績と計画")).not.toBeInTheDocument();
      expect(screen.queryByText("終業時の見込み")).not.toBeInTheDocument();
      expect(screen.getByText("稼働率")).toBeInTheDocument();
    });

    it("極端に低くても、達成率と実績は必ず残し、無限に繰り返さない", async () => {
      stubLayout(() => 900, 100);
      renderWithQueryClient(<ProductionPlanWidget widget={makeWidget()} />);

      expect(await screen.findByText("54%")).toBeInTheDocument();
      expect(screen.queryByLabelText("時間別の実績と計画")).not.toBeInTheDocument();
      expect(screen.queryByText("終業時の見込み")).not.toBeInTheDocument();
      expect(screen.queryByText("稼働率")).not.toBeInTheDocument();
      expect(screen.getByText(/^650/)).toBeInTheDocument();
    });

    it("収まるなら何も省かない", async () => {
      stubLayout(() => 200, 300);
      renderWithQueryClient(<ProductionPlanWidget widget={makeWidget()} />);

      await screen.findByText("54%");
      expect(screen.getByLabelText("時間別の実績と計画")).toBeInTheDocument();
      expect(screen.getByText("終業時の見込み")).toBeInTheDocument();
    });
  });
});
