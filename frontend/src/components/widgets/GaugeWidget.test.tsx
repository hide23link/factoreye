import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import type { Sensor, Widget } from "../../types";
import { GaugeWidget } from "./GaugeWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadings: vi.fn(),
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "成形機3 温度",
  ingestKey: "t",
  unit: "℃",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: 80,
  thresholdMaxCritical: 90,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "",
  updatedAt: "",
};

const widget = (over: Partial<Widget> = {}): Widget => ({
  id: "w1",
  dashboardId: "d1",
  sensorId: "s1",
  type: "Gauge",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 4,
  gridHeight: 6,
  config: {},
  createdAt: "",
  updatedAt: "",
  ...over,
});

const reading = (value: number) => ({ readings: [{ id: 1, sensorId: "s1", value, recordedAt: "2026-10-24T00:00:00Z" }], total: 1 });

afterEach(() => vi.restoreAllMocks());

describe("GaugeWidget", () => {
  it("センサー未設定のときは案内", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<GaugeWidget widget={widget({ sensorId: null })} />);
    expect(screen.getByText("センサーが設定されていません")).toBeInTheDocument();
  });

  it("いまの値・単位・状態を出す（正常）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(reading(65.43));
    renderWithQueryClient(<GaugeWidget widget={widget()} />);
    expect(await screen.findByText("65.4")).toBeInTheDocument();
    expect(screen.getByText("℃")).toBeInTheDocument();
    expect(screen.getByText(/正常/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "成形機3 温度: 65.4 ℃" })).toBeInTheDocument();
  });

  it("軽故障・重故障のしきい値を超えたら、状態の文言が変わる", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(reading(85));
    const first = renderWithQueryClient(<GaugeWidget widget={widget()} />);
    expect(await screen.findByText(/軽故障のしきい値を超過/)).toBeInTheDocument();
    first.unmount();

    vi.mocked(api.fetchSensorReadings).mockResolvedValue(reading(95));
    renderWithQueryClient(<GaugeWidget widget={widget({ id: "w2" })} />);
    expect(await screen.findByText(/重故障のしきい値を超過/)).toBeInTheDocument();
  });

  it("データが無いときは「データがありません」", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
    renderWithQueryClient(<GaugeWidget widget={widget()} />);
    expect(await screen.findByText("データがありません")).toBeInTheDocument();
  });

  it("小数の桁数の設定に従う", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(reading(65.4321));
    renderWithQueryClient(<GaugeWidget widget={widget({ config: { decimals: 3 } })} />);
    expect(await screen.findByText("65.432")).toBeInTheDocument();
  });

  it("取得に失敗したら、エラーの案内", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockRejectedValue(new Error("down"));
    renderWithQueryClient(<GaugeWidget widget={widget()} />);
    expect(await screen.findByText(/測定値を取得できませんでした/)).toBeInTheDocument();
  });

  it("針は、値の位置を向く（範囲の真ん中の値なら、真上）。値が範囲の外なら端に寄る", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(reading(50));
    const { container, unmount } = renderWithQueryClient(<GaugeWidget widget={widget({ config: { gaugeMin: 0, gaugeMax: 100 } })} />);
    await screen.findByText("50.0");
    const needle = container.querySelector("line") as SVGLineElement;
    expect(parseFloat(needle.getAttribute("x2") ?? "")).toBeCloseTo(100);
    expect(parseFloat(needle.getAttribute("y2") ?? "")).toBeCloseTo(100 - 66);
    unmount();

    vi.mocked(api.fetchSensorReadings).mockResolvedValue(reading(500));
    const over = renderWithQueryClient(<GaugeWidget widget={widget({ id: "w2", config: { gaugeMin: 0, gaugeMax: 100 } })} />);
    await screen.findByText("500.0");
    const edge = over.container.querySelector("line") as SVGLineElement;
    expect(parseFloat(edge.getAttribute("x2") ?? "")).toBeCloseTo(100 + 66);
  });

  it("手動の範囲なら、設定した最小・最大の数字が目盛りの端に出る", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(reading(20));
    renderWithQueryClient(<GaugeWidget widget={widget({ config: { gaugeMin: 10, gaugeMax: 150 } })} />);
    expect(await screen.findByText("10")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
  });
});
