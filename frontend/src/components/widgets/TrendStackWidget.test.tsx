import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import { useTimeRangeStore } from "../../store/useTimeRangeStore";
import { useTrendCursorStore } from "../../store/useTrendCursorStore";
import type { Sensor, Widget } from "../../types";
import { TrendStackWidget } from "./TrendStackWidget";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  fetchLatestReadings: vi.fn(),
}));

import * as api from "../../lib/api";

function sensor(id: string, name: string, extra: Partial<Sensor> = {}): Sensor {
  return {
    id,
    name,
    ingestKey: id,
    unit: "ppm",
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: null,
    thresholdMaxCritical: null,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

const widget = (ids: string[]): Widget => ({
  id: "w1",
  dashboardId: "d1",
  sensorId: ids[0] ?? null,
  type: "TrendStack",
  gridColumn: 1,
  gridRow: 1,
  gridWidth: 12,
  gridHeight: 10,
  config: { sensorIds: ids },
  createdAt: "",
  updatedAt: "",
});

/** 今から minutesAgo 分前を始まりとする 1 分の区間 */
const bucketAgo = (minutesAgo: number, value: number, max = value, min = value) => ({
  start: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  avg: value,
  min,
  max,
  count: 1,
});

beforeEach(() => {
  useTrendCursorStore.getState().clearAll();
  useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 60 * 60_000 } });
  vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TrendStackWidget（計器グラフ）", () => {
  it("センサーが無ければ、入れ方を案内する", () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    renderWithQueryClient(<TrendStackWidget widget={widget([])} />);
    expect(screen.getByText(/センサーが設定されていません/)).toBeInTheDocument();
  });

  it("最高・最低・平均・今の値・しきい値の数値を出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("co2", "洋室 CO2", { thresholdMaxCritical: 1000 })]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [bucketAgo(30, 600, 640, 580), bucketAgo(20, 900, 980, 880), bucketAgo(2, 1050, 1103, 1040)],
    });

    renderWithQueryClient(<TrendStackWidget widget={widget(["co2"])} />);

    // 左の欄の名前と、行の上（狭い枠のとき用）の名前
    expect((await screen.findAllByText("洋室 CO2")).length).toBeGreaterThan(0);
    // 最高は区間の max（1103）、最低は区間の min（580）。左の欄と、行の上（狭い枠のとき用）の両方に出る
    expect(screen.getAllByText("1103").length).toBeGreaterThan(0);
    expect(screen.getAllByText("580").length).toBeGreaterThan(0);
    expect(screen.getByText(/最高 1103/)).toBeInTheDocument();
    // 今の値の札（最後の区間の値）。重故障のしきい値の外
    expect(screen.getByText("1050")).toBeInTheDocument();
    // しきい値の線の数値（軽故障と重故障の両方があるときは、重故障の線にだけ付ける）
    expect(screen.getByText("上限 1000")).toBeInTheDocument();
    expect(screen.getAllByText("上限 1000 ppm").length).toBeGreaterThan(0);
    // 縦軸の目盛り
    expect(screen.getByText("1200")).toBeInTheDocument();
  });

  it("最後の受信が古ければ、最後の値を橙で出し、受信なしと知らせる（数字は消さない）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("t", "外気南 温度")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [bucketAgo(50, 8.9), bucketAgo(40, 9.1)],
    });

    renderWithQueryClient(<TrendStackWidget widget={widget(["t"])} />);

    const tag = await screen.findByText(/^9\.1/, { selector: "span.font-num" });
    expect(tag).toHaveStyle({ color: "var(--fe-amb)" });
    // 札の左の矢印も、札と同じ色
    expect(screen.getByTestId("now-tag-arrow")).toHaveStyle({ borderRightColor: "var(--fe-amb)" });
    expect(screen.getAllByText(/受信なし/).length).toBeGreaterThan(0);
  });

  it("軽故障と重故障の両方があるときは、線は 2 本とも引き、数値は重故障の線にだけ付ける（文字が重ならない）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("co2", "洋室 CO2", { thresholdMaxWarning: 900, thresholdMaxCritical: 1000 })]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(5, 800)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["co2"])} />);

    await screen.findAllByText("洋室 CO2");
    expect(screen.getByText("上限 1000")).toBeInTheDocument();
    expect(screen.queryByText("上限 900")).not.toBeInTheDocument();
  });

  it("カーソルは最初から出ていて、その時刻の値を、同じ画面の別のウィジェット用に出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA"), sensor("b", "センサーB")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["a", "b"])} />);

    await screen.findAllByText("センサーA");
    // 見出しに、期間と、カーソルの時刻
    expect(screen.getByText("推移 1H")).toBeInTheDocument();
    expect(screen.getByText(/^カーソル \d{2}:\d{2}$/)).toBeInTheDocument();
    // 時刻と、行ごとの値（カーソルの位置にデータが無いので「---」）を、この計器グラフ（w1）の分として store に出している
    await vi.waitFor(() => expect(useTrendCursorStore.getState().widgets.w1?.rows.map((row) => row.name)).toEqual(["センサーA", "センサーB"]));
    expect(useTrendCursorStore.getState().widgets.w1?.time).toBeDefined();
    expect(useTrendCursorStore.getState().widgets.w1?.spanMs).toBe(60 * 60_000);
  });

  it("センサーごとに 1 行ずつ並べる", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA"), sensor("b", "センサーB")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["a", "b"])} />);

    expect((await screen.findAllByText("センサーA")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("センサーB").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("img", { name: /の推移/ })).toHaveLength(2);
  });

  it("今の値は、区間の平均ではなく本当の最新の測定値（区間の平均がしきい値の内でも、最新が外なら赤）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("co2", "洋室 CO2", { thresholdMaxCritical: 1000 })]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [bucketAgo(10, 700), bucketAgo(1, 950, 1080, 900)],
    });
    vi.mocked(api.fetchLatestReadings).mockResolvedValue({
      readings: [{ sensorId: "co2", value: 1080, recordedAt: new Date(Date.now() - 5_000).toISOString() }],
      total: 1,
    });

    renderWithQueryClient(<TrendStackWidget widget={widget(["co2"])} />);

    const tag = await screen.findByText("1080", { selector: "span.font-num" });
    expect(tag).toHaveStyle({ color: "var(--fe-red)" });
  });

  it("計器グラフを 2 つ置いても、カーソルの値は混ざらない。片方が消えても、もう片方の分は残る", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA"), sensor("b", "センサーB")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });
    const first = { ...widget(["a"]), id: "w1" };
    const second = { ...widget(["b"]), id: "w2" };

    const { rerender } = renderWithQueryClient(
      <>{[<TrendStackWidget key="w1" widget={first} />, <TrendStackWidget key="w2" widget={second} />]}</>,
    );

    await vi.waitFor(() => {
      const widgets = useTrendCursorStore.getState().widgets;
      expect(widgets.w1?.rows.map((row) => row.name)).toEqual(["センサーA"]);
      expect(widgets.w2?.rows.map((row) => row.name)).toEqual(["センサーB"]);
    });

    // 片方（w1）を消す: w2 の分は残る
    // key をそろえて、w2 を作り直さずに w1 だけ外す
    rerender(<>{[<TrendStackWidget key="w2" widget={second} />]}</>);
    await vi.waitFor(() => expect(useTrendCursorStore.getState().widgets.w1).toBeUndefined());
    expect(useTrendCursorStore.getState().widgets.w2?.rows.map((row) => row.name)).toEqual(["センサーB"]);
  });

  it("最高・最低の札とカーソルの札は重ならない（カーソルを優先し、最高・最低を逃がす）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [bucketAgo(50, 600, 700, 500), bucketAgo(30, 650, 700, 600), bucketAgo(5, 900, 1000, 800)],
    });
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("センサーA");
    // 札はどれも px の位置で置かれる（左上の角が、枠の外に出ない）
    const labels = screen.getAllByText(/^最(高|低) \d/, { selector: "span.font-num" }).filter((el) => el.style.left !== "");
    expect(labels.length).toBe(2);
    for (const label of labels) {
      expect(parseFloat(label.style.left)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(label.style.top)).toBeGreaterThanOrEqual(0);
    }
  });
});
