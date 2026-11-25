import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fireEvent, renderWithQueryClient, screen } from "../../test/test-utils";
import { cancelPendingCursorTime, useCursorTimeStore } from "../../store/useCursorTimeStore";
import { useGraphViewStore } from "../../store/useGraphViewStore";
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

/** センサーごとの設定色（config.colors）つきのウィジェット */
const coloredWidget = (ids: string[], colors: string[]): Widget => ({ ...widget(ids), config: { sensorIds: ids, colors } });

/** jsdom は色を rgb(...) に直して返すので、試験の期待値の #rrggbb も同じ形にする */
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

/** 行の線（aria-label つきの svg の最初の path ＝ 正常なときの線）の色 */
const lineStrokes = () =>
  screen.getAllByRole("img").map((svg) => (svg.querySelector("path") as SVGPathElement).style.stroke);

/** センサー名の文字の色（左の欄の名前。title で引く） */
const nameColors = (name: string) => screen.getAllByTitle(name).map((el) => (el as HTMLElement).style.color);

/** 今から minutesAgo 分前を始まりとする 1 分の区間 */
const bucketAgo = (minutesAgo: number, value: number, max = value, min = value) => ({
  start: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  avg: value,
  min,
  max,
  count: 1,
});

beforeEach(() => {
  useGraphViewStore.setState({ showBands: true, compare: "none" });
  useCursorTimeStore.getState().reset();
  useTrendCursorStore.getState().clearAll();
  useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 60 * 60_000 } });
  vi.mocked(api.fetchLatestReadings).mockResolvedValue({ readings: [], total: 0 });
});

afterEach(() => {
  cancelPendingCursorTime();
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

  it("縦軸の左上に、センサーの単位を出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("co2", "洋室 CO2")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(5, 600)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["co2"])} />);

    expect(await screen.findByTestId("trend-y-unit")).toHaveTextContent("ppm");
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

  /** 今の時刻の「時:分」（分の変わり目をまたいでも通るよう、1 分前も許す） */
  const clockNow = () => {
    const text = (ms: number) => new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    return [text(Date.now()), text(Date.now() - 60_000)];
  };

  /** グラフの上の枠（マウス・指の操作を受ける）。大きさ（600×80）を、測れたことにする */
  const plotOf = () => {
    const plot = screen.getAllByTestId("trend-plot")[0];
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 80, right: 600, bottom: 80, x: 0, y: 0, toJSON: () => ({}) });
    return plot;
  };

  it("カーソルは最初「現在位置」（表示範囲の右端＝今）で、縦線の真下（時間の軸の行）に時刻の札を出す", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("センサーA");

    // 共有の時刻は null（利用者が動かしていない）。見出しの札と、時間の軸の行の札が、どちらも今の時刻
    expect(useCursorTimeStore.getState().time).toBeNull();
    expect(clockNow()).toContain(screen.getByTestId("cursor-time-label").textContent);
    expect(screen.getByText(/^カーソル \d{2}:\d{2}$/).textContent).toBe(`カーソル ${screen.getByTestId("cursor-time-label").textContent}`);
    // 動かしていないので、「今に戻す」は出ない
    expect(screen.queryByRole("button", { name: "今に戻す" })).not.toBeInTheDocument();
  });

  it("グラフの上で動かすと、その時刻に動き（札の時刻も変わる）、マウスが外れても残る。「今に戻す」で現在位置へ戻る", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("センサーA");
    const plot = plotOf();

    // 幅 600px の左端（x = 0）＝ 1 時間前
    fireEvent.pointerMove(plot, { clientX: 0 });
    await vi.waitFor(() => expect(useCursorTimeStore.getState().time).not.toBeNull());
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    const oneHourAgoBefore = new Date(Date.now() - 61 * 60_000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    expect([oneHourAgo, oneHourAgoBefore]).toContain(screen.getByTestId("cursor-time-label").textContent);

    // マウスが外れても、その位置に残る（勝手に今へ戻さない）
    fireEvent.pointerLeave(plot);
    expect(useCursorTimeStore.getState().time).not.toBeNull();

    // 「今に戻す」で、現在位置（右端）に戻る
    fireEvent.click(screen.getByRole("button", { name: "今に戻す" }));
    expect(useCursorTimeStore.getState().time).toBeNull();
    expect(clockNow()).toContain(screen.getByTestId("cursor-time-label").textContent);
  });

  it("指でタップしたとき（pointerdown）も、その位置にカーソルが動く", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("センサーA");

    fireEvent.pointerDown(plotOf(), { clientX: 300 });
    await vi.waitFor(() => expect(useCursorTimeStore.getState().time).not.toBeNull());
  });

  it("計器グラフを 2 つ置くと、片方で動かしたカーソルが、もう片方にも同じ時刻で連動する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA"), sensor("b", "センサーB")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });
    const first = { ...widget(["a"]), id: "w1" };
    const second = { ...widget(["b"]), id: "w2" };

    renderWithQueryClient(
      <>
        <TrendStackWidget widget={first} />
        <TrendStackWidget widget={second} />
      </>,
    );
    await screen.findAllByText("センサーB");

    fireEvent.pointerMove(plotOf(), { clientX: 0 });
    await vi.waitFor(() => expect(useCursorTimeStore.getState().time).not.toBeNull());
    // どちらの計器グラフの札も、同じ時刻（1 時間前）になる。「今に戻す」と見出しのカーソルの札は、動かした方（1 つ目）にだけ出る
    const labels = screen.getAllByTestId("cursor-time-label").map((el) => el.textContent);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toBe(labels[1]);
    expect(screen.getAllByRole("button", { name: "今に戻す" })).toHaveLength(1);
    expect(screen.getAllByText(/^カーソル \d/)).toHaveLength(1);
  });

  it("カーソルを誰も動かしていない間（owner が不明）は、どの計器グラフにも見出しのカーソルの札が出る", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA"), sensor("b", "センサーB")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });
    renderWithQueryClient(
      <>
        <TrendStackWidget widget={{ ...widget(["a"]), id: "w1" }} />
        <TrendStackWidget widget={{ ...widget(["b"]), id: "w2" }} />
      </>,
    );
    await screen.findAllByText("センサーB");
    expect(screen.getAllByText(/^カーソル \d/)).toHaveLength(2);
    // 動かしていないので「今に戻す」は出ない
    expect(screen.queryByRole("button", { name: "今に戻す" })).not.toBeInTheDocument();
  });

  it("期間が 1 日を超えるときは、時刻の札に日付も付ける（月/日 時:分）", async () => {
    useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 3 * 24 * 60 * 60_000 } });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(1, 5)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("センサーA");

    expect(screen.getByTestId("cursor-time-label").textContent).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
  });
});

describe("TrendStackWidget の色（センサーごとの設定色）", () => {
  const recent = { bucketSeconds: 60, buckets: [bucketAgo(30, 10), bucketAgo(2, 11)] };

  it("正常なときは、線も名前も設定色で描く", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 温度")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue(recent);
    renderWithQueryClient(<TrendStackWidget widget={coloredWidget(["a"], ["#2fa84f"])} />);
    await screen.findAllByTitle("洋室 温度");
    expect(lineStrokes()).toEqual([rgb("#2fa84f")]);
    expect(nameColors("洋室 温度")).toContain(rgb("#2fa84f"));
  });

  it("センサーが 2 つのときは、行ごとに別の設定色で描く（順番どおり）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 温度"), sensor("b", "和室 温度")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue(recent);
    renderWithQueryClient(<TrendStackWidget widget={coloredWidget(["a", "b"], ["#2f80ed", "#8b5cf6"])} />);
    await screen.findAllByTitle("和室 温度");
    expect(lineStrokes()).toEqual([rgb("#2f80ed"), rgb("#8b5cf6")]);
  });

  it("設定色を変えて描き直すと、線の色も変わる", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 温度")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue(recent);
    const { rerender } = renderWithQueryClient(<TrendStackWidget widget={coloredWidget(["a"], ["#2f80ed"])} />);
    await screen.findAllByTitle("洋室 温度");
    expect(lineStrokes()).toEqual([rgb("#2f80ed")]);
    rerender(<TrendStackWidget widget={coloredWidget(["a"], ["#0fb5a8"])} />);
    expect(lineStrokes()).toEqual([rgb("#0fb5a8")]);
  });

  it("重故障のしきい値を超えている間は、名前を赤にする（設定色で上書きされない）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 CO2", { thresholdMaxCritical: 1000 })]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [bucketAgo(30, 600), bucketAgo(2, 1200)],
    });
    renderWithQueryClient(<TrendStackWidget widget={coloredWidget(["a"], ["#2fa84f"])} />);
    await screen.findAllByTitle("洋室 CO2");
    expect(nameColors("洋室 CO2")).toEqual(expect.arrayContaining(["var(--fe-red)"]));
    expect(nameColors("洋室 CO2")).not.toContain(rgb("#2fa84f"));
  });

  it("受信なしのときは、名前を橙にする（設定色で上書きされない）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "外気南 温度")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [bucketAgo(50, 8.9), bucketAgo(40, 9.1)],
    });
    renderWithQueryClient(<TrendStackWidget widget={coloredWidget(["a"], ["#2fa84f"])} />);
    await screen.findAllByTitle("外気南 温度");
    expect(nameColors("外気南 温度")).toEqual(expect.arrayContaining(["var(--fe-amb)"]));
    expect(nameColors("外気南 温度")).not.toContain(rgb("#2fa84f"));
  });
});

describe("TrendStackWidget の警報の帯", () => {
  const bandWidgetData = () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 CO2", { thresholdMaxWarning: 800, thresholdMaxCritical: 1000 })]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 60,
      buckets: [bucketAgo(50, 600), bucketAgo(40, 900), bucketAgo(30, 1100), bucketAgo(20, 600), bucketAgo(10, 600)],
    });
  };

  it("しきい値を超えた区間に、帯を重ねる（注意は橙、警報は赤）", async () => {
    bandWidgetData();
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("洋室 CO2");
    const bands = await screen.findAllByTestId("threshold-band");
    // 900 と 1100 は連続しているので、1 つの帯。区間内の最悪は警報
    expect(bands).toHaveLength(1);
    expect(bands[0]).toHaveAttribute("data-level", "critical");
  });

  it("平均は超えていなくても、区間の最高が警報値なら、帯が出る（行の「最高」札と食い違わない）", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 CO2", { thresholdMaxCritical: 1000 })]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 600,
      buckets: [bucketAgo(50, 600), bucketAgo(30, 600, 1200, 500), bucketAgo(10, 600)],
    });
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    const bands = await screen.findAllByTestId("threshold-band");
    expect(bands).toHaveLength(1);
    expect(bands[0]).toHaveAttribute("data-level", "critical");
    expect(screen.getByText(/最高 1200/)).toBeInTheDocument();
  });

  it("しきい値が無ければ、帯は出ない", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 CO2")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(30, 1100), bucketAgo(20, 1200)] });
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("洋室 CO2");
    expect(screen.queryByTestId("threshold-band")).not.toBeInTheDocument();
  });

  it("見出しの「警報の帯」を切ると、帯が消える", async () => {
    bandWidgetData();
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByTestId("threshold-band");
    fireEvent.click(screen.getByRole("button", { name: "警報の帯を表示する" }));
    expect(screen.queryByTestId("threshold-band")).not.toBeInTheDocument();
  });

  it("カーソルが帯の中にあると、値の一覧に「警報 … 最高 …」を出す", async () => {
    bandWidgetData();
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByTestId("threshold-band");
    // カーソルを、警報の点（30 分前）に置く
    useCursorTimeStore.setState({ time: Date.now() - 30 * 60_000 + 30_000, owner: "w1" });
    await vi.waitFor(() => {
      const note = useTrendCursorStore.getState().widgets.w1?.rows[0]?.notes?.[0]?.text;
      expect(note).toMatch(/^警報 \d{2}:\d{2}〜\d{2}:\d{2} 最高 1100$/);
    });
    expect(screen.getByTestId("cursor-note")).toHaveTextContent(/^警報 /);
  });
});

describe("TrendStackWidget の昨日の重ね", () => {
  /** 範囲の始め（from）が今から 1 時間より前なら比較側の取得（24 時間ずらしたもの） */
  const isCompareCall = (from: string) => Date.now() - Date.parse(from) > 20 * 3_600_000;

  it("比較を「昨日」にすると、24 時間ずらした範囲を取り、灰色の点線を重ねる。縦軸は両方が入る", async () => {
    useGraphViewStore.setState({ compare: "yesterday" });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 CO2")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (_id, from) =>
      isCompareCall(from)
        ? { bucketSeconds: 60, buckets: [{ ...bucketAgo(30, 5000), start: new Date(Date.parse(from) + 30 * 60_000).toISOString() }] }
        : { bucketSeconds: 60, buckets: [bucketAgo(30, 600), bucketAgo(10, 620)] },
    );
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    expect(await screen.findByTestId("compare-line")).toBeInTheDocument();
    const calls = vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls;
    const [today, previous] = [calls.find((c) => !isCompareCall(c[1])), calls.find((c) => isCompareCall(c[1]))];
    // 比較側の範囲は、今の範囲の 24 時間前（取得の数を増やさないよう、1 区間の長さに切り下げるので、最大で 1 区間（1 分）のずれ）
    for (const index of [1, 2] as const) {
      const gap = Date.parse(today![index]) - Date.parse(previous![index]);
      expect(gap).toBeGreaterThanOrEqual(24 * 3_600_000);
      expect(gap).toBeLessThan(24 * 3_600_000 + 60_000);
    }
    // 縦軸は、比較の値（5000）が入る高さまで伸びる
    expect(screen.getByText("5000")).toBeInTheDocument();
  });

  it("比較しない（既定）ときは、比較の取得も線も無い", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 CO2")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(30, 600)] });
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("洋室 CO2");
    expect(screen.queryByTestId("compare-line")).not.toBeInTheDocument();
    expect(vi.mocked(api.fetchSensorReadingsDownsampled)).toHaveBeenCalledTimes(1);
  });

  it("比較側の取得が失敗しても、今日の線は消えない", async () => {
    useGraphViewStore.setState({ compare: "yesterday" });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 CO2")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (_id, from) => {
      if (isCompareCall(from)) throw new Error("boom");
      return { bucketSeconds: 60, buckets: [bucketAgo(30, 600), bucketAgo(10, 620)] };
    });
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("洋室 CO2");
    await vi.waitFor(() => expect(vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.some((c) => isCompareCall(c[1]))).toBe(true));
    expect(screen.queryByText("データを取得できませんでした")).not.toBeInTheDocument();
    expect(lineStrokes()).toHaveLength(1);
    expect(screen.queryByTestId("compare-line")).not.toBeInTheDocument();
  });

  it("カーソルの値の一覧に「昨日 62.4（差 +4.1）」の形で出す", async () => {
    useGraphViewStore.setState({ compare: "yesterday" });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "温度", { unit: "℃" })]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (_id, from) =>
      isCompareCall(from)
        ? { bucketSeconds: 60, buckets: [{ ...bucketAgo(0, 62.4), start: new Date(Date.parse(from) + 30 * 60_000).toISOString() }] }
        : { bucketSeconds: 60, buckets: [bucketAgo(30, 66.5)] },
    );
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findByTestId("compare-line");
    useCursorTimeStore.setState({ time: Date.now() - 30 * 60_000 + 30_000, owner: "w1" });
    await vi.waitFor(() => {
      const notes = useTrendCursorStore.getState().widgets.w1?.rows[0]?.notes?.map((n) => n.text) ?? [];
      expect(notes).toEqual([expect.stringMatching(/^昨日 62\.4（差 \+4\.\d）$/)]);
    });
  });

  it("昨日から先週に切り替えた直後は、昨日のデータを先週として描かない（空にする）", async () => {
    useGraphViewStore.setState({ compare: "yesterday" });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 CO2")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation((_id, from) => {
      const ago = Date.now() - Date.parse(from);
      // 先週の取得は、返ってこない（取得中のまま）
      if (ago > 6 * 24 * 3_600_000) return new Promise(() => {});
      if (isCompareCall(from)) return Promise.resolve({ bucketSeconds: 60, buckets: [{ ...bucketAgo(0, 700), start: new Date(Date.parse(from) + 30 * 60_000).toISOString() }] });
      return Promise.resolve({ bucketSeconds: 60, buckets: [bucketAgo(30, 600), bucketAgo(10, 620)] });
    });
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findByTestId("compare-line");
    fireEvent.click(screen.getByRole("button", { name: "比較: 先週" }));
    await vi.waitFor(() => expect(screen.queryByTestId("compare-line")).not.toBeInTheDocument());
  });

  it("比較側は取り直さない。直近の表示で今の線が取り直されても、比較側の取得は増えない（範囲を丸めるため）", async () => {
    useGraphViewStore.setState({ compare: "yesterday" });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "洋室 CO2")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (_id, from) =>
      isCompareCall(from) ? { bucketSeconds: 60, buckets: [] } : { bucketSeconds: 60, buckets: [bucketAgo(30, 600)] },
    );
    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("洋室 CO2");
    await vi.waitFor(() => expect(vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.filter((c) => isCompareCall(c[1]))).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.filter((c) => isCompareCall(c[1]))).toHaveLength(1);
  });
});

describe("TrendStackWidget のマウスでの時間の操作（拡大・縮小・移動）", () => {
  const HOUR = 60 * 60_000;
  const box = (width: number) => () => ({ left: 0, top: 0, width, height: 80, right: width, bottom: 80, x: 0, y: 0, toJSON: () => ({}) });

  /** グラフの上の枠（幅 600px として測れたことにする） */
  const plotOf = () => {
    const plot = screen.getAllByTestId("trend-plot")[0];
    plot.getBoundingClientRect = box(600);
    return plot;
  };
  /** 下の時刻の軸（幅 600px） */
  const axisOf = () => {
    const axis = screen.getByTestId("trend-time-axis");
    axis.getBoundingClientRect = box(600);
    return axis;
  };
  // 押している間の動きは buttons: 1（左ボタンを押している）。離した後・押していない動きは buttons: 0
  const press = { pointerType: "mouse", button: 0, buttons: 1, pointerId: 1 };
  const release = { pointerType: "mouse", button: 0, buttons: 0, pointerId: 1 };
  const range = () => useTimeRangeStore.getState().range;
  const spanOf = () => {
    const current = range();
    return current.mode === "absolute" ? current.to - current.from : current.durationMs;
  };
  /** 線などを入れた枠（時刻の軸のドラッグ中に横へずらす） */
  const shiftOf = (element: HTMLElement) => (element.firstElementChild as HTMLElement).style.transform;

  async function renderOne(config: Widget["config"] = {}) {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [bucketAgo(30, 5), bucketAgo(1, 6)] });
    renderWithQueryClient(<TrendStackWidget widget={{ ...widget(["a"]), config: { sensorIds: ["a"], ...config } }} />);
    await screen.findAllByText("センサーA");
  }

  /** 押したまま from → to へ動かして離す */
  function dragOn(element: HTMLElement, from: number, to: number) {
    fireEvent.pointerDown(element, { ...press, clientX: from });
    fireEvent.pointerMove(element, { ...press, clientX: (from + to) / 2 });
    fireEvent.pointerMove(element, { ...press, clientX: to });
    fireEvent.pointerUp(element, { ...release, clientX: to });
  }

  it("押したまま横に動かすと水色の帯で範囲を選び、離すとその範囲に拡大する（履歴に 1 つ積む）", async () => {
    await renderOne();
    const plot = plotOf();
    const historyBefore = window.history.length;

    fireEvent.pointerDown(plot, { ...press, clientX: 100 });
    fireEvent.pointerMove(plot, { ...press, clientX: 400 });
    expect(await screen.findByTestId("zoom-selection")).toBeInTheDocument();
    fireEvent.pointerUp(plot, { ...release, clientX: 400 });

    // 600px のうち 100〜400px ＝ 1 時間の 1/6〜4/6（30 分の幅）
    expect(range().mode).toBe("absolute");
    expect(Math.abs(spanOf() - 30 * 60_000)).toBeLessThan(2_000);
    expect(window.history.length).toBe(historyBefore + 1);
    expect(screen.queryByTestId("zoom-selection")).not.toBeInTheDocument();
  });

  it("6px 未満のドラッグは、ただのクリック（範囲は変えない。カーソルだけ動く）", async () => {
    await renderOne();
    dragOn(plotOf(), 100, 104);

    expect(range()).toEqual({ mode: "relative", durationMs: HOUR });
    expect(screen.queryByTestId("zoom-selection")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(useCursorTimeStore.getState().time).not.toBeNull());
  });

  it("離したことが届かず（キャプチャが外れた・ボタンが離れている）なら、選択をやめる。後で範囲は変わらない", async () => {
    await renderOne();
    const plot = plotOf();

    fireEvent.pointerDown(plot, { ...press, clientX: 100 });
    fireEvent.pointerMove(plot, { ...press, clientX: 300 });
    expect(await screen.findByTestId("zoom-selection")).toBeInTheDocument();
    fireEvent.lostPointerCapture(plot, { pointerId: 1 });
    expect(screen.queryByTestId("zoom-selection")).not.toBeInTheDocument();
    fireEvent.pointerUp(plot, { ...release, clientX: 400 });
    expect(range()).toEqual({ mode: "relative", durationMs: HOUR });

    // ボタンを離した後の動き（buttons: 0）でも、選択を続けない
    fireEvent.pointerDown(plot, { ...press, clientX: 100 });
    fireEvent.pointerMove(plot, { ...release, clientX: 400 });
    expect(screen.queryByTestId("zoom-selection")).not.toBeInTheDocument();
  });

  it("指でなぞったときは、今までどおりカーソルが動くだけ（範囲は変えない）", async () => {
    await renderOne();
    const plot = plotOf();
    const touch = { pointerType: "touch", button: 0, buttons: 1, pointerId: 2 };

    fireEvent.pointerDown(plot, { ...touch, clientX: 100 });
    fireEvent.pointerMove(plot, { ...touch, clientX: 400 });
    fireEvent.pointerUp(plot, { ...touch, buttons: 0, clientX: 400 });
    fireEvent.doubleClick(plot, { clientX: 400 });

    expect(range()).toEqual({ mode: "relative", durationMs: HOUR });
    expect(screen.queryByTestId("zoom-selection")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(useCursorTimeStore.getState().time).not.toBeNull());
  });

  it("ダブルクリックで、その位置を中心に 2 倍に縮小する", async () => {
    await renderOne();
    const plot = plotOf();
    const historyBefore = window.history.length;

    dragOn(plot, 300, 300);
    fireEvent.doubleClick(plot, { clientX: 300 });

    expect(range().mode).toBe("absolute");
    expect(Math.abs(spanOf() - 2 * HOUR)).toBeLessThan(2_000);
    expect(window.history.length).toBe(historyBefore + 1);
  });

  it("ドラッグで拡大した直後のダブルクリックは、縮小にしない（拡大を打ち消さない）", async () => {
    await renderOne();
    const plot = plotOf();

    dragOn(plot, 100, 400);
    fireEvent.doubleClick(plot, { clientX: 100 });

    expect(Math.abs(spanOf() - 30 * 60_000)).toBeLessThan(2_000);
  });

  it("Ctrl＋ホイールで、マウスの位置を中心に拡大する", async () => {
    await renderOne();
    const plot = plotOf();

    fireEvent.pointerMove(plot, { ...release, clientX: 300 });
    fireEvent.wheel(plot, { ctrlKey: true, deltaY: -100 });

    expect(range().mode).toBe("absolute");
    expect(Math.abs(spanOf() - 0.8 * HOUR)).toBeLessThan(2_000);
  });

  it("下の時刻の軸を右へドラッグ: 動かしている間は線をずらして見せるだけで、範囲も取得も変えない。離したら 1 回だけ範囲を変える", async () => {
    await renderOne();
    const axis = axisOf();
    const plot = plotOf();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fetchesBefore = vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.length;
    const historyBefore = window.history.length;
    const toBefore = Date.now();

    fireEvent.pointerDown(axis, { ...press, clientX: 300 });
    for (let x = 310; x <= 360; x += 10) fireEvent.pointerMove(axis, { ...press, clientX: x });
    // 動かしている間: 線は 60px 右にずれて見え、範囲と取得の回数は変わらない
    expect(shiftOf(plot)).toBe("translateX(60px)");
    expect(range()).toEqual({ mode: "relative", durationMs: HOUR });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.length).toBe(fetchesBefore);

    fireEvent.pointerUp(axis, { ...release, clientX: 360 });

    // 60px ＝ 幅 600px の 1/10 ＝ 6 分だけ過去へ。ずらしは戻り、範囲を変えて取り直す（行 1 つなので 1 回）
    const current = range();
    expect(current.mode).toBe("absolute");
    expect(Math.abs(spanOf() - HOUR)).toBeLessThan(2_000);
    if (current.mode === "absolute") expect(Math.abs(toBefore - 6 * 60_000 - current.to)).toBeLessThan(40_000);
    expect(window.history.length).toBe(historyBefore + 1);
    expect(shiftOf(plot)).toBe("");
    await vi.waitFor(() => expect(vi.mocked(api.fetchSensorReadingsDownsampled).mock.calls.length).toBe(fetchesBefore + 1));
  });

  it("時刻の軸を左（未来）へはずらさない。今に届いたら直近の表示のまま", async () => {
    await renderOne();
    const axis = axisOf();
    const plot = plotOf();

    fireEvent.pointerDown(axis, { ...press, clientX: 300 });
    fireEvent.pointerMove(axis, { ...press, clientX: 200 });
    expect(shiftOf(plot)).toBe("");
    fireEvent.pointerUp(axis, { ...release, clientX: 200 });
    expect(range()).toEqual({ mode: "relative", durationMs: HOUR });
  });

  it("ウィジェット固有の期間のときは、ドラッグ・ダブルクリック・軸のドラッグで、ダッシュボードの期間を変えない", async () => {
    await renderOne({ rangeHours: 6 });
    const plot = plotOf();

    dragOn(plot, 100, 400);
    fireEvent.doubleClick(plot, { clientX: 300 });
    dragOn(axisOf(), 300, 400);

    expect(range()).toEqual({ mode: "relative", durationMs: HOUR });
    expect(screen.queryByTestId("zoom-selection")).not.toBeInTheDocument();
  });
});

describe("TrendStackWidget のカーソルの札の時刻（表示範囲が 1 時間より短いときだけ秒まで）", () => {
  it("6 時間の表示は、今までどおり時:分", async () => {
    useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 6 * 60 * 60_000 } });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 180, buckets: [bucketAgo(10, 5)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("センサーA");

    expect(screen.getByTestId("cursor-time-label").textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(screen.getByText(/^カーソル \d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it("15 分の表示は、時:分:秒", async () => {
    useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 15 * 60_000 } });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("a", "センサーA")]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 2, buckets: [bucketAgo(1, 5)] });

    renderWithQueryClient(<TrendStackWidget widget={widget(["a"])} />);
    await screen.findAllByText("センサーA");

    expect(screen.getByTestId("cursor-time-label").textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("TrendStackWidget の行ごとの縦軸の最小・最大（rowAxisRanges。soft）", () => {
  /** 行の縦軸の目盛りの数字 */
  const yTicks = (rowIndex: number) =>
    Array.from(document.querySelectorAll(".trend-yaxis")[rowIndex].querySelectorAll("span.absolute.right-1\\.5")).map((el) => Number(el.textContent));

  async function renderRows(config: Widget["config"]) {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor("p", "気圧", { unit: "hPa" }), sensor("t", "温度", { unit: "℃" })]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockImplementation(async (id) =>
      id === "p"
        ? { bucketSeconds: 60, buckets: [bucketAgo(30, 1012.2), bucketAgo(20, 1012.5), bucketAgo(2, 1012.3)] }
        : { bucketSeconds: 60, buckets: [bucketAgo(30, 24), bucketAgo(2, 26)] },
    );
    renderWithQueryClient(<TrendStackWidget widget={{ ...widget(["p", "t"]), config: { sensorIds: ["p", "t"], ...config } }} />);
    await screen.findAllByText("温度");
    await vi.waitFor(() => expect(yTicks(0).length).toBeGreaterThan(0));
  }

  it("設定が無いときは、今までどおり自動（小さな揺れに合わせた細かい目盛り）", async () => {
    await renderRows({});
    expect(yTicks(0)[0]).toBeGreaterThan(1010);
    expect(yTicks(0).at(-1)).toBeLessThan(1015);
  });

  it("気圧の行だけ 1000〜1025 にすると、その行はその範囲で描き、温度の行は自動のまま", async () => {
    await renderRows({ rowAxisRanges: { p: { min: 1000, max: 1025 } } });
    // 目盛りは、両端に少し余白をとった切りのよい数（例: 995〜1030 を 5 ごと）
    await vi.waitFor(() => expect(yTicks(0)[0]).toBeLessThanOrEqual(1000));
    expect(yTicks(0).at(-1)).toBeGreaterThanOrEqual(1025);
    expect(yTicks(1).every((tick) => tick > 20 && tick < 30)).toBe(true);
  });

  it("データが範囲からはみ出したら、軸を広げる（線は切らない）。大きく外れても範囲は外れない", async () => {
    await renderRows({ rowAxisRanges: { p: { min: 1000, max: 1005 } } });
    await vi.waitFor(() => expect(yTicks(0)[0]).toBeLessThanOrEqual(1000));
    expect(yTicks(0).at(-1)).toBeGreaterThanOrEqual(1012.5);
  });

  it("片方だけ（最小 0）でも使える", async () => {
    await renderRows({ rowAxisRanges: { t: { min: 0 } } });
    await vi.waitFor(() => expect(yTicks(1)[0]).toBeLessThanOrEqual(0));
    expect(yTicks(1).at(-1)).toBeGreaterThanOrEqual(26);
  });
});
