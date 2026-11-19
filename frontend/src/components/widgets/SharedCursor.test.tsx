import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { Line, LineChart, XAxis, YAxis } from "recharts";

import { act, fireEvent, render, screen, within } from "../../test/test-utils";
import { useDragSelect } from "../../hooks/useDragSelect";
import { withSharedCursor } from "../../lib/shared-cursor";
import { cancelPendingCursorTime, useCursorTimeStore } from "../../store/useCursorTimeStore";
import { CursorResetButton, SharedCursorOverlay } from "./SharedCursor";

const FROM = new Date(2026, 10, 18, 9, 0).getTime();
const TO = new Date(2026, 10, 18, 10, 0).getTime();
const data = [
  { time: FROM, value: 1 },
  { time: TO, value: 2 },
];

/** 固定の大きさ（600×200）で描いた、時刻の軸のグラフ。共有のカーソルの縦線と時刻の札を、グラフの子として置く */
function Chart() {
  return (
    <LineChart width={600} height={200} data={data}>
      <XAxis dataKey="time" type="number" domain={[FROM, TO]} />
      <YAxis />
      <Line dataKey="value" isAnimationActive={false} />
      <SharedCursorOverlay from={FROM} to={TO} />
    </LineChart>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
  useCursorTimeStore.getState().reset();
});

afterEach(() => {
  cancelPendingCursorTime();
  useCursorTimeStore.getState().reset();
  vi.useRealTimers();
});

describe("SharedCursorOverlay（ふつうのグラフ・複数のグラフの共有カーソル）", () => {
  it("動かしていないときは、表示範囲の右端（現在位置）に縦線と時刻の札を出す", () => {
    render(<Chart />);
    const cursor = screen.getByTestId("shared-cursor");
    expect(cursor.textContent).toBe("10:00");
    // 縦線は、グラフの右端（横軸の終わり）
    const line = cursor.querySelector("line") as SVGLineElement;
    expect(Number(line.getAttribute("x1"))).toBeGreaterThan(500);
  });

  it("共有の時刻を動かすと、その時刻に縦線と札が動く。範囲の外の時刻は、範囲の端に収める", () => {
    render(<Chart />);
    const xOf = () => Number((screen.getByTestId("shared-cursor").querySelector("line") as SVGLineElement).getAttribute("x1"));
    const right = xOf();

    act(() => useCursorTimeStore.getState().setTime(new Date(2026, 10, 18, 9, 30).getTime()));
    expect(screen.getByTestId("shared-cursor").textContent).toBe("09:30");
    expect(xOf()).toBeLessThan(right);
  });

  it("範囲の外の時刻は、範囲の端（右端なら右端）に収める", () => {
    useCursorTimeStore.getState().setTime(TO + 3 * 3_600_000);
    render(<Chart />);
    expect(screen.getByTestId("shared-cursor").textContent).toBe("10:00");
  });

  it("札は、グラフの左端でも内側に寄って、枠の外へ切れない", () => {
    useCursorTimeStore.getState().setTime(FROM);
    render(<Chart />);
    const rect = screen.getByTestId("shared-cursor").querySelector("rect") as SVGRectElement;
    // 縦軸の幅の分だけ内側（プロット領域の左端 ≥ 0）に収まっている
    expect(Number(rect.getAttribute("x"))).toBeGreaterThanOrEqual(0);
  });
});

describe("CursorResetButton（カーソルを今に戻す）", () => {
  it("動かしていないときは出さない。動かしたあとに出て、押すと現在位置に戻る", () => {
    render(<CursorResetButton widgetId="w1" />);
    expect(screen.queryByRole("button", { name: "カーソルを今に戻す" })).not.toBeInTheDocument();

    act(() => useCursorTimeStore.getState().setTime(FROM));
    fireEvent.click(screen.getByRole("button", { name: "カーソルを今に戻す" }));
    expect(useCursorTimeStore.getState().time).toBeNull();
  });
});

describe("CursorResetButton は、カーソルを動かしたグラフにだけ出る", () => {
  it("別のグラフ（owner が違う）には出さず、動かしたグラフと、動かした人が不明のときには出す", () => {
    render(
      <>
        <div data-testid="a"><CursorResetButton widgetId="a" /></div>
        <div data-testid="b"><CursorResetButton widgetId="b" /></div>
      </>,
    );
    act(() => useCursorTimeStore.getState().setTime(FROM, "a"));
    expect(within(screen.getByTestId("a")).queryByRole("button")).toBeInTheDocument();
    expect(within(screen.getByTestId("b")).queryByRole("button")).not.toBeInTheDocument();

    act(() => useCursorTimeStore.getState().setTime(FROM + 60_000));
    expect(within(screen.getByTestId("b")).queryByRole("button")).toBeInTheDocument();
  });
});

describe("ふつうのグラフ・複数のグラフの操作（withSharedCursor）→ ほかのグラフの連動", () => {
  it("1 つのグラフ（ふつうのグラフ・複数のグラフ）の上で動かすと、同じダッシュボードのほかのグラフの縦線と時刻の札が、同じ時刻に動く", () => {
    render(
      <>
        <Chart />
        <Chart />
      </>,
    );
    const stepMs = (TO - FROM) / 500;
    // グラフ A（ふつうのグラフ）の上で、9:20 にマウスを動かす
    const handlersA = withSharedCursor(true, stepMs, {});
    act(() => {
      handlersA.onMouseMove?.({ activeLabel: new Date(2026, 10, 18, 9, 20).getTime() });
      vi.advanceTimersByTime(20);
    });
    // グラフ B（複数のグラフ）も、同じ時刻（9:20）に動く
    const labels = screen.getAllByTestId("shared-cursor").map((el) => el.textContent);
    expect(labels).toEqual(["09:20", "09:20"]);
    // 今度は B 側で、タップ（click）して 9:45 に動かす → A も 9:45
    const handlersB = withSharedCursor(true, stepMs, {});
    act(() => {
      handlersB.onClick?.({ activeLabel: new Date(2026, 10, 18, 9, 45).getTime() });
      vi.advanceTimersByTime(20);
    });
    expect(screen.getAllByTestId("shared-cursor").map((el) => el.textContent)).toEqual(["09:45", "09:45"]);
  });

  it("ドラッグで期間を選ぶ操作（元のイベント）と両立する（押して・動かして・離すと選択が通り、動かした位置にカーソルも動く）", () => {
    const selected: Array<[number, number]> = [];
    const { result } = renderHook(() => useDragSelect((from, to) => selected.push([from, to])));
    const handlers = withSharedCursor(true, 1000, result.current.handlers);

    act(() => {
      handlers.onMouseDown?.({ activeLabel: 1_000_000 });
    });
    // 元のイベントの state（anchor）を反映した最新のイベントで続ける
    const moving = withSharedCursor(true, 1000, result.current.handlers);
    act(() => {
      moving.onMouseMove?.({ activeLabel: 1_100_000 });
      vi.advanceTimersByTime(20);
    });
    expect(useCursorTimeStore.getState().time).toBe(1_100_000);
    const ending = withSharedCursor(true, 1000, result.current.handlers);
    act(() => {
      ending.onMouseUp?.();
    });
    expect(selected).toEqual([[1_000_000, 1_100_000]]);
  });
});

describe("CursorResetButton の色", () => {
  it("固定の色ではなく、画面の明るさに合わせた変数の色（暗い画面で白く浮かない）", () => {
    render(<CursorResetButton widgetId="w1" />);
    act(() => useCursorTimeStore.getState().setTime(FROM));
    const button = screen.getByRole("button", { name: "カーソルを今に戻す" });
    const style = button.getAttribute("style") ?? "";
    expect(style).toContain("var(--fe-line)");
    expect(style).toContain("var(--fe-chrome)");
    expect(style).toContain("var(--fe-ink)");
    expect(button.className).not.toMatch(/gray|white/);
  });
});
