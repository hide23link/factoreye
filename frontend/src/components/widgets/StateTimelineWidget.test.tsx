import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { StateTimelineWidget, TIMELINE_BUCKETS } from "./StateTimelineWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
}));

// 現在時刻は 2024-01-01 12:00:00（ローカル）に固定する
vi.mock("../../hooks/useNow", () => ({ useNow: () => new Date(2024, 0, 1, 12, 0, 0).getTime() }));

import * as api from "../../lib/api";

const NOW = new Date(2024, 0, 1, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const FROM = NOW - 2 * HOUR;
const CELL = (2 * HOUR) / TIMELINE_BUCKETS;

function sensor(id: string, name: string, max: number | null = null): Sensor {
  return {
    id,
    name,
    ingestKey: name,
    unit: "",
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: max,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: new Date(2023, 0, 1).toISOString(),
    updatedAt: "",
  };
}

function widget(config: Widget["config"], ids: string[] = ["s1"]): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: ids[0] ?? null,
    type: "StateTimeline",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 12,
    gridHeight: 6,
    config: { ...config, sensorIds: ids },
    createdAt: "",
    updatedAt: "",
  };
}

/** index 番目の区間に値（min〜max）が 1 件ある区間 */
const bucket = (index: number, min: number, max = min) => ({
  start: new Date(FROM + index * CELL).toISOString(),
  min,
  avg: (min + max) / 2,
  max,
  count: 1,
});

beforeEach(() => {
  useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 2 * HOUR } });
  vi.mocked(api.fetchSensors).mockResolvedValue([sensor("s1", "line1-power", 100), sensor("s2", "line2-power")]);
});

describe("StateTimelineWidget", () => {
  it("センサーが無ければ設定を促す", () => {
    renderWithQueryClient(<StateTimelineWidget widget={widget({}, [])} />);
    expect(screen.getByText(/センサーが設定されていません/)).toBeInTheDocument();
  });

  it("稼働・警報・受信なしを帯にし、稼働率を出す", async () => {
    // 区間 0〜71 は稼働、72〜95 は重故障（100 超）、残りは受信なし → 稼働率 72 / 144 = 50%
    const buckets = [
      ...Array.from({ length: 72 }, (_, i) => bucket(i, 10, 20)),
      ...Array.from({ length: 24 }, (_, i) => bucket(72 + i, 50, 150)),
    ];
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: CELL / 1000, buckets });
    renderWithQueryClient(<StateTimelineWidget widget={widget({})} />);

    const band = await screen.findByRole("img", { name: /line1-power: 稼働率 50%/ });
    expect(band).toHaveAttribute("aria-label", expect.stringContaining("警報（重故障）"));
    // 帯は 3 本（稼働・警報・受信なし）。ホバーの文は、状態・時刻・長さ
    const titles = Array.from(band.children).map((el) => el.getAttribute("title"));
    expect(titles).toHaveLength(3);
    expect(titles[0]).toBe("稼働 10:00〜11:00（60 分）");
    expect(titles[1]).toBe("警報（重故障） 11:00〜11:20（20 分）");
    expect(titles[2]).toMatch(/^受信なし 11:20〜12:00/);
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("停止とみなす値は、設定した行だけ有効", async () => {
    // 2 行とも、全区間で値が 0。s1 だけ「停止とみなす値」0 を設定
    const buckets = Array.from({ length: TIMELINE_BUCKETS }, (_, i) => bucket(i, 0));
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: CELL / 1000, buckets });
    renderWithQueryClient(<StateTimelineWidget widget={widget({ stateStopValues: { s1: 0 } }, ["s1", "s2"])} />);

    const stopped = await screen.findByRole("img", { name: /line1-power: 稼働率 0%/ });
    expect(stopped.children[0].getAttribute("title")).toMatch(/^停止 /);
    const running = await screen.findByRole("img", { name: /line2-power: 稼働率 100%/ });
    expect(running.children[0].getAttribute("title")).toMatch(/^稼働 /);
  });

  it("凡例に 4 つの状態の色の見本を出す", async () => {
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 50, buckets: [] });
    renderWithQueryClient(<StateTimelineWidget widget={widget({})} />);
    expect(await screen.findByText("稼働")).toBeInTheDocument();
    for (const label of ["警報（重故障）", "警報（軽故障）", "停止", "受信なし"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
