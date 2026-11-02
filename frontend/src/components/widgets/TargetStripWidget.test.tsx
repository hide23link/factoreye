import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { TargetStripWidget } from "./TargetStripWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
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

// 2 時間 = 120 マス。最後のマス(119)が今（12:07）を含む。マス i の開始 = from + i 分
const TO = (Math.floor(NOW / MIN) + 1) * MIN;
const FROM = TO - 120 * MIN;
const bucket = (index: number, value: number, count = 1) => ({
  start: new Date(FROM + index * MIN).toISOString(),
  min: value,
  avg: value,
  max: value,
  count,
});

beforeEach(() => {
  vi.mocked(api.fetchSensors).mockResolvedValue([sensor("s1", "atom01-heartbeat"), sensor("s2", "atom02-heartbeat")]);
});

describe("TargetStripWidget", () => {
  it("センサーが無ければ設定を促す", () => {
    renderWithQueryClient(<TargetStripWidget widget={widget({}, [])} />);
    expect(screen.getByText(/センサーが設定されていません/)).toBeInTheDocument();
  });

  it("受信の確認: 値が来たマスは緑、欠けは赤、達成率と丸印が出る", async () => {
    // マス 10〜114 は受信あり。115〜118 は欠け、119（今）はまだ集計中
    const present = Array.from({ length: 105 }, (_, i) => i + 10);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: present.map((i) => bucket(i, 1)),
    });
    renderWithQueryClient(<TargetStripWidget widget={widget({})} />);

    const strip = await screen.findByRole("img", { name: /atom01-heartbeat: 直近2時間/ });
    const cells = Array.from(strip.children);
    expect(cells).toHaveLength(120);
    expect(cells[114].className).toContain("bg-green-500");
    expect(cells[116].className).toContain("bg-red-400");
    expect(cells[119].className).toContain("ring-gray-300"); // 今のマスは集計中
    // 末尾の完結したマス 118〜115 が未達（4 連続）→ 赤い丸印
    expect(screen.getByRole("img", { name: "未達が続いています" })).toBeInTheDocument();
  });

  it("複数センサーは 1 行ずつ出る", async () => {
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucket(118, 1)] });
    renderWithQueryClient(<TargetStripWidget widget={widget({}, ["s1", "s2"])} />);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /直近2時間/ })).toHaveLength(2));
    expect(screen.getByText("atom02-heartbeat")).toBeInTheDocument();
  });

  it("生産の目標: 1 時間 120・5 分 → 1 マス 10 個以上で緑", async () => {
    // 5 分マスの範囲は 1 分マスと別。24 マス。最後の 2 つ前(22)=10 個、(21)=9 個
    const to5 = (Math.floor(NOW / (5 * MIN)) + 1) * 5 * MIN;
    const from5 = to5 - 24 * 5 * MIN;
    const b5 = (index: number, sum: number) => ({
      start: new Date(from5 + index * 5 * MIN).toISOString(),
      min: sum,
      avg: sum,
      max: sum,
      count: 1,
    });
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 300,
      buckets: [b5(22, 10), b5(21, 9)],
    });
    renderWithQueryClient(
      <TargetStripWidget widget={widget({ stripBucketMinutes: 5, stripHourlyTarget: 120 })} />,
    );

    const strip = await screen.findByRole("img", { name: /atom01-heartbeat: 直近2時間/ });
    const cells = Array.from(strip.children);
    expect(cells).toHaveLength(24);
    expect(cells[22].className).toContain("bg-green-500");
    expect(cells[21].className).toContain("bg-red-400");
    expect(screen.getByText(/目標 10 以上で緑/)).toBeInTheDocument();
  });

  it("取得に失敗したら再試行を出す", async () => {
    vi.mocked(api.fetchSensorReadingsDownsampled).mockRejectedValue(new Error("network"));
    renderWithQueryClient(<TargetStripWidget widget={widget({})} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("測定値を取得できませんでした");
  });
});
