import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { linkPeriod, type LinkPeriod } from "../lib/link-range";
import { fireEvent, render, screen } from "../test/test-utils";
import { useLinkGestures } from "./useLinkGestures";

const MINUTE = 60_000;
const NOW = new Date(2026, 10, 10, 11, 30).getTime();
// 試験用のグラフの枠: 左端 0、幅 300px
const BOX = { left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

/** フックを付けた枠。期間は data-* に出す（テストから読むため） */
function Harness(props: { start?: LinkPeriod; onTap?: (ratio: number) => void; onDoubleTap?: () => void; onEnd?: () => void }) {
  const [period, setPeriod] = useState<LinkPeriod>(props.start ?? linkPeriod(60));
  const gestures = useLinkGestures({
    period,
    now: NOW,
    maxMs: Number.POSITIVE_INFINITY,
    onChange: (next) => setPeriod(next),
    onTap: props.onTap ?? (() => {}),
    onDoubleTap: props.onDoubleTap ?? (() => {}),
    onEnd: props.onEnd,
  });
  return (
    <div
      data-testid="chart"
      data-duration={period.durationMs}
      data-end={period.endMs ?? "now"}
      ref={(element) => {
        if (element) element.getBoundingClientRect = () => BOX;
        gestures.ref(element);
      }}
      {...gestures.handlers}
    />
  );
}

const chart = () => screen.getByTestId("chart");
const minutes = () => Number(chart().dataset.duration) / MINUTE;
const down = (id: number, x: number, y: number) => fireEvent.pointerDown(chart(), { pointerId: id, clientX: x, clientY: y });
const move = (id: number, x: number, y: number) => fireEvent.pointerMove(chart(), { pointerId: id, clientX: x, clientY: y });
const up = (id: number, x: number, y: number) => fireEvent.pointerUp(chart(), { pointerId: id, clientX: x, clientY: y });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useLinkGestures", () => {
  it("なぞり始めの向きで決め、斜めにしても途中で変えない（左右と決めたら、上下に動かしても長さは変わらない）", () => {
    render(<Harness />);
    down(1, 100, 100);
    move(1, 120, 102); // 左右に決まる
    move(1, 130, 300); // 下へ大きく動かしても、拡大・縮小にはならない
    up(1, 130, 300);
    expect(minutes()).toBe(60);
    expect(chart().dataset.end).not.toBe("now"); // 右へなぞったので過去へ動いた
  });

  it("上下に決めたら、左右に動かしても時間は動かない（今のまま）", () => {
    render(<Harness />);
    down(1, 100, 100);
    move(1, 102, 130); // 上下に決まる（下へ＝長く）
    move(1, 250, 130);
    up(1, 250, 130);
    expect(minutes()).toBeGreaterThan(60);
    expect(chart().dataset.end).toBe("now");
  });

  it("ピンチの後に片方の指を離し、残りを動かしても、ピンチ前の期間に戻らない", () => {
    render(<Harness />);
    down(1, 100, 150);
    down(2, 200, 150);
    move(2, 300, 150); // 指の間が 100 → 200px: 長さは半分
    expect(minutes()).toBe(30);
    up(2, 300, 150);
    move(1, 112, 150); // 残った指を 12px 右へ（なぞりのやり直しは、今の位置・今の期間から数える）
    expect(minutes()).toBe(30);
    // 30 分の 12/300 = 72 秒だけ過去へ（ピンチ前の 60 分には戻らない）
    expect(Number(chart().dataset.end)).toBe(NOW - 72_000);
    up(1, 112, 150);
    expect(minutes()).toBe(30);
  });

  it("動かさずに離すとタップ（位置の割合）、続けて 2 回でダブルタップ", () => {
    const onTap = vi.fn();
    const onDoubleTap = vi.fn();
    const onEnd = vi.fn();
    render(<Harness onTap={onTap} onDoubleTap={onDoubleTap} onEnd={onEnd} />);
    down(1, 75, 100);
    up(1, 75, 100);
    expect(onTap).toHaveBeenCalledWith(0.25);
    down(1, 75, 100);
    up(1, 75, 100);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("ホイールで拡大・縮小し、枠が外れたらホイールの処理も外す", () => {
    const { unmount } = render(<Harness />);
    const element = chart();
    const remove = vi.spyOn(element, "removeEventListener");
    fireEvent.wheel(element, { deltaY: 100, clientX: 300 });
    expect(minutes()).toBeCloseTo(69);
    unmount();
    expect(remove).toHaveBeenCalledWith("wheel", expect.any(Function));
  });
});
