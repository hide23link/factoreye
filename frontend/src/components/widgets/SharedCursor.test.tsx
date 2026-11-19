import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Line, LineChart, XAxis, YAxis } from "recharts";

import { act, fireEvent, render, screen } from "../../test/test-utils";
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
  useCursorTimeStore.getState().reset();
});

afterEach(() => {
  cancelPendingCursorTime();
  useCursorTimeStore.getState().reset();
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
    render(<CursorResetButton />);
    expect(screen.queryByRole("button", { name: "カーソルを今に戻す" })).not.toBeInTheDocument();

    act(() => useCursorTimeStore.getState().setTime(FROM));
    fireEvent.click(screen.getByRole("button", { name: "カーソルを今に戻す" }));
    expect(useCursorTimeStore.getState().time).toBeNull();
  });
});
