import { beforeEach, describe, expect, it, vi } from "vitest";

import { stripWindow } from "../../lib/target-strip";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { TargetStripWidget } from "./TargetStripWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  fetchSensorReadings: vi.fn(),
}));

// 現在時刻は 2024-01-01 12:07:30（ローカル）に固定する
vi.mock("../../hooks/useNow", () => ({ useNow: () => new Date(2024, 0, 1, 12, 7, 30).getTime() }));

import * as api from "../../lib/api";

const NOW = new Date(2024, 0, 1, 12, 7, 30).getTime();
const MIN = 60000;

function sensor(id: string, name: string): Sensor {
  return {
    id,
    name,
    ingestKey: name,
    unit: "",
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: null,
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
    type: "TargetStrip",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 8,
    gridHeight: 6,
    config: { ...config, sensorIds: ids },
    createdAt: "",
    updatedAt: "",
  };
}

// 表示範囲は、グラフと同じダッシュボードの時間範囲。ここでは直近 2 時間にする
const TWO_HOURS = 2 * 60 * MIN;
const W1 = stripWindow({ from: NOW - TWO_HOURS, to: NOW }, 1);
const W5 = stripWindow({ from: NOW - TWO_HOURS, to: NOW }, 5);
const bucket = (index: number, value: number, count = 1) => ({
  start: new Date(W1.from + index * MIN).toISOString(),
  min: value,
  avg: value,
  max: value,
  count,
});

beforeEach(() => {
  useTimeRangeStore.setState({ range: { mode: "relative", durationMs: TWO_HOURS } });
  vi.mocked(api.fetchSensors).mockResolvedValue([sensor("s1", "atom01-heartbeat"), sensor("s2", "atom02-heartbeat")]);
});

describe("TargetStripWidget", () => {
  it("センサーが無ければ設定を促す", () => {
    renderWithQueryClient(<TargetStripWidget widget={widget({}, [])} />);
    expect(screen.getByText(/センサーが設定されていません/)).toBeInTheDocument();
  });

  it("受信の確認: 値が来たマスは緑、欠けは赤、達成率と丸印が出る", async () => {
    // 最後の 6 マスより前は受信あり。最後から 2〜5 番目は欠け、最後（今）はまだ集計中
    const last = W1.bucketCount - 1;
    const present = Array.from({ length: last - 5 }, (_, i) => i);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: present.map((i) => bucket(i, 1)),
    });
    renderWithQueryClient(<TargetStripWidget widget={widget({})} />);

    const strip = await screen.findByRole("img", { name: /atom01-heartbeat: 表示期間/ });
    const cells = Array.from(strip.children);
    expect(cells).toHaveLength(W1.bucketCount);
    expect(cells[last - 6].className).toContain("bg-green-500");
    expect(cells[last - 3].className).toContain("bg-red-400");
    expect(cells[last].className).toContain("ring-gray-300"); // 今のマスは集計中
    // 末尾の完結したマスが未達（4 連続）→ 赤い丸印
    expect(screen.getByRole("img", { name: "未達が続いています" })).toBeInTheDocument();
  });

  it("複数センサーは 1 行ずつ出る", async () => {
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucket(118, 1)] });
    renderWithQueryClient(<TargetStripWidget widget={widget({}, ["s1", "s2"])} />);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /表示期間/ })).toHaveLength(2));
    expect(screen.getByText("atom02-heartbeat")).toBeInTheDocument();
  });

  it("生産の目標: 1 時間 120・5 分 → 1 マス 10 個以上で緑", async () => {
    // 5 分マス。最後の 1 つ前=10 個、2 つ前=9 個
    const last5 = W5.bucketCount - 1;
    const b5 = (index: number, sum: number) => ({
      start: new Date(W5.from + index * 5 * MIN).toISOString(),
      min: sum,
      avg: sum,
      max: sum,
      count: 1,
    });
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 300,
      buckets: [b5(last5 - 1, 10), b5(last5 - 2, 9)],
    });
    renderWithQueryClient(
      <TargetStripWidget widget={widget({ stripBucketMinutes: 5, stripHourlyTarget: 120 })} />,
    );

    const strip = await screen.findByRole("img", { name: /atom01-heartbeat: 表示期間/ });
    const cells = Array.from(strip.children);
    expect(cells).toHaveLength(W5.bucketCount);
    expect(cells[last5 - 1].className).toContain("bg-green-500");
    expect(cells[last5 - 2].className).toContain("bg-red-400");
    expect(screen.getByText(/目標 10 以上で緑/)).toBeInTheDocument();
  });

  it("表示期間は、ダッシュボードの時間範囲に従う（変えるとマスの数が変わる）", async () => {
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });
    useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 30 * MIN } });
    renderWithQueryClient(<TargetStripWidget widget={widget({})} />);
    const strip = await screen.findByRole("img", { name: /atom01-heartbeat: 表示期間/ });
    const thirty = stripWindow({ from: NOW - 30 * MIN, to: NOW }, 1);
    expect(strip.children).toHaveLength(thirty.bucketCount);
    expect(thirty.bucketCount).toBeLessThan(W1.bucketCount);
  });

  it("グラフ個別の期間（rangeHours）があれば、それに従う", async () => {
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });
    renderWithQueryClient(<TargetStripWidget widget={widget({ rangeHours: 1 })} />);
    const strip = await screen.findByRole("img", { name: /atom01-heartbeat: 表示期間/ });
    expect(strip.children).toHaveLength(stripWindow({ from: NOW - 60 * MIN, to: NOW }, 1).bucketCount);
  });

  it("受信の間隔: 60 秒おきなら緑、1 回抜ければ赤（分の境目でも赤にならない）", async () => {
    // 表示の始めより前から、60 秒おきに受信。途中で 1 回抜ける（141 秒の間隔）
    const fetchFrom = W1.from - 5 * MIN;
    const received: number[] = [];
    for (let t = fetchFrom + 59000; t < NOW; t += 60000) received.push(t);
    const cutAt = received[Math.floor(received.length / 2)];
    const readings = received
      .filter((t) => !(t > cutAt && t < cutAt + 120000))
      .map((t) => ({ sensorId: "s1", value: 1, recordedAt: new Date(t).toISOString() }))
      .reverse(); // API は新しい順
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings, total: readings.length });
    renderWithQueryClient(
      <TargetStripWidget widget={widget({ stripJudge: "interval", stripMaxGapSeconds: 90 })} />,
    );

    const strip = await screen.findByRole("img", { name: /atom01-heartbeat: 表示期間/ });
    const cells = Array.from(strip.children);
    expect(cells).toHaveLength(W1.bucketCount);
    const reds = cells.filter((c) => c.className.includes("bg-red-400"));
    expect(reds.length).toBeGreaterThanOrEqual(1);
    expect(reds.length).toBeLessThanOrEqual(3);
    expect(cells.filter((c) => c.className.includes("bg-green-500")).length).toBe(cells.length - reds.length);
    expect(screen.getByText(/前回の受信から 90 秒以内に次の受信があれば緑/)).toBeInTheDocument();
    // 判定は件数の API（間引き）ではなく、受信の時刻で行う
    expect(api.fetchSensorReadingsDownsampled).not.toHaveBeenCalled();
  });

  it("取得に失敗したら再試行を出す", async () => {
    vi.mocked(api.fetchSensorReadingsDownsampled).mockRejectedValue(new Error("network"));
    renderWithQueryClient(<TargetStripWidget widget={widget({})} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("測定値を取得できませんでした");
  });
});
