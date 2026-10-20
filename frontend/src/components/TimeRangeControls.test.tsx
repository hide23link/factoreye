import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fireEvent, renderWithQueryClient, screen } from "../test/test-utils";
import { DEFAULT_RANGE } from "../lib/timeRange";
import { useTimeRangeStore } from "../store/useTimeRangeStore";
import { TimeRangeControls } from "./TimeRangeControls";

vi.mock("../hooks/useNow", () => ({
  useNow: () => new Date("2024-01-01T01:00:00.000Z").getTime(),
}));

beforeEach(() => {
  // 操作の時点の現在時刻で計算するため、時計だけを固定する（01:00 UTC）
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-01-01T01:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
});

describe("TimeRangeControls", () => {
  it("既定は「自動で更新」の直近 1 時間", () => {
    renderWithQueryClient(<TimeRangeControls />);

    expect(screen.getByTestId("time-range-label")).toHaveTextContent("自動で更新：直近 1 時間");
  });

  it("前へを押すと、幅の分だけ過去の固定期間になる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TimeRangeControls />);

    await user.click(screen.getByRole("button", { name: "前へ" }));

    // 現在（01:00 UTC）の 1 時間前の 1 時間（23:00〜00:00 UTC）
    expect(useTimeRangeStore.getState().range).toEqual({
      mode: "absolute",
      from: Date.parse("2024-01-01T00:00:00.000Z") - 60 * 60 * 1000,
      to: Date.parse("2024-01-01T00:00:00.000Z"),
    });
    expect(screen.getByTestId("time-range-label")).toHaveTextContent("固定");
  });

  it("今に戻るを押すと、直近モードに戻る（幅はそのまま）", async () => {
    const user = userEvent.setup();
    useTimeRangeStore.setState({
      range: {
        mode: "absolute",
        from: Date.parse("2023-12-31T20:00:00.000Z"),
        to: Date.parse("2023-12-31T21:00:00.000Z"),
      },
    });
    renderWithQueryClient(<TimeRangeControls />);

    await user.click(screen.getByRole("button", { name: "今に戻る" }));

    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 60 * 60 * 1000 });
  });

  it("プリセットを選ぶと、その幅の直近モードになる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TimeRangeControls />);

    await user.selectOptions(screen.getByRole("combobox", { name: "表示期間" }), "24h");

    expect(useTimeRangeStore.getState().range).toEqual({
      mode: "relative",
      durationMs: 24 * 60 * 60 * 1000,
    });
  });

  it("拡大を押すと、直近モードの幅が半分になる", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TimeRangeControls />);

    await user.click(screen.getByRole("button", { name: "拡大" }));

    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 30 * 60 * 1000 });
  });

  it("一時停止を押すと、今の表示範囲を固定して動きを止める（幅はそのまま）", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TimeRangeControls />);

    await user.click(screen.getByRole("button", { name: "一時停止" }));

    // 現在（01:00 UTC）の直近 1 時間の範囲（00:00〜01:00 UTC）を、そのまま固定する
    expect(useTimeRangeStore.getState().range).toEqual({
      mode: "absolute",
      from: Date.parse("2024-01-01T00:00:00.000Z"),
      to: Date.parse("2024-01-01T01:00:00.000Z"),
    });
    // 固定モードでは、一時停止のボタンは出ない（今に戻るで再開する）
    expect(screen.queryByRole("button", { name: "一時停止" })).toBeNull();
  });

  it("期間を指定: 開始だけ変えて適用しても、欄に見えている終了の値が使われ、エラーにならない", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderWithQueryClient(<TimeRangeControls />);

    await user.click(screen.getByText("期間を指定"));
    const from = screen.getByLabelText("開始");
    // 欄に表示されている開始より 10 分前にする
    const shown = (from as HTMLInputElement).value;
    const earlier = new Date(new Date(shown).getTime() - 10 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const text = `${earlier.getFullYear()}-${pad(earlier.getMonth() + 1)}-${pad(earlier.getDate())}T${pad(earlier.getHours())}:${pad(earlier.getMinutes())}`;
    fireEvent.change(from, { target: { value: text } });
    await user.click(screen.getByRole("button", { name: "適用" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(useTimeRangeStore.getState().range.mode).toBe("absolute");
  });
});
