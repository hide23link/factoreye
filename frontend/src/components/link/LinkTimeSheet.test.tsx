import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PICKED_MINUTES } from "../../lib/link-range";
import { fireEvent, render, screen } from "../../test/test-utils";
import { LinkTimeSheet } from "./LinkTimeSheet";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 例の「今」（端末の時刻で 2026-11-10 11:30）
const NOW = new Date(2026, 10, 10, 11, 30).getTime();
const NO_LIMIT = Number.POSITIVE_INFINITY;
const SAAS_LIMIT = 14 * DAY;
/** 帯の幅（px）。1 px = 6 分 */
const TRACK_WIDTH = 240;

/** LinkScreen と同じく、① の時刻を外で持つ */
function Harness({ now = NOW, maxMs = NO_LIMIT, onJump }: { now?: number; maxMs?: number; onJump: (startMs: number) => void }) {
  const [picked, setPicked] = useState(DEFAULT_PICKED_MINUTES);
  return <LinkTimeSheet now={now} maxMs={maxMs} pickedMinutes={picked} onPick={setPicked} onJump={onJump} onClose={() => {}} />;
}

const slider = () => screen.getByRole("slider", { name: "時刻を選ぶ" });
const day = (month: number, date: number, time = "8:00") => screen.getByRole("button", { name: `${month}月${date}日 ${time}から` });
const monthTitle = () => screen.getByText(/^\d{4}年\d{1,2}月$/).textContent;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: TRACK_WIDTH,
    bottom: 44,
    width: TRACK_WIDTH,
    height: 44,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("近道", () => {
  it("5 つあり、押すとすぐ、その時刻へ移る", () => {
    const onJump = vi.fn();
    render(<Harness onJump={onJump} />);

    const labels = screen.getAllByRole("button").filter((b) => b.closest('[aria-label="近道"]')).map((b) => b.textContent);
    expect(labels).toEqual(["1 時間前", "3 時間前", "今日 8:00", "昨日 8:00", "昨日 13:00"]);
    fireEvent.click(screen.getByRole("button", { name: "昨日 13:00" }));
    expect(onJump).toHaveBeenCalledWith(new Date(2026, 10, 9, 13, 0).getTime());
    fireEvent.click(screen.getByRole("button", { name: "1 時間前" }));
    expect(onJump).toHaveBeenLastCalledWith(NOW - HOUR);
  });

  it("未来になる近道は押せない（7:30 に開くと「今日 8:00」）", () => {
    const onJump = vi.fn();
    render(<Harness now={new Date(2026, 10, 10, 7, 30).getTime()} onJump={onJump} />);

    expect(screen.getByRole("button", { name: "今日 8:00" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "昨日 13:00" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "今日 8:00" }));
    expect(onJump).not.toHaveBeenCalled();
  });
});

describe("① 時刻の帯", () => {
  it("初めは 8:00。押すだけで、その位置の時刻を 15 分刻みで選ぶ。ここでは移らない", () => {
    const onJump = vi.fn();
    render(<Harness onJump={onJump} />);

    expect(slider()).toHaveAttribute("aria-valuenow", "480");
    expect(screen.getByText("8:00")).toBeInTheDocument();
    // 121 px = 12:06 → 12:00
    fireEvent.pointerDown(slider(), { pointerId: 1, clientX: 121 });
    fireEvent.pointerUp(slider(), { pointerId: 1, clientX: 121 });
    expect(slider()).toHaveAttribute("aria-valuenow", "720");
    expect(screen.getByText("12:00")).toBeInTheDocument();
    expect(onJump).not.toHaveBeenCalled();
  });

  it("なぞると、指に合わせて時刻が変わる。離した後の動きでは変わらない", () => {
    const onJump = vi.fn();
    render(<Harness onJump={onJump} />);

    fireEvent.pointerDown(slider(), { pointerId: 1, clientX: 60 }); // 6:00
    fireEvent.pointerMove(slider(), { pointerId: 1, clientX: 91 }); // 9:06 → 9:00
    expect(slider()).toHaveAttribute("aria-valuenow", "540");
    fireEvent.pointerMove(slider(), { pointerId: 1, clientX: 400 }); // 帯の外 → 23:45
    expect(slider()).toHaveAttribute("aria-valuenow", "1425");
    fireEvent.pointerUp(slider(), { pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(slider(), { pointerId: 1, clientX: 30 });
    expect(slider()).toHaveAttribute("aria-valuenow", "1425");
    expect(onJump).not.toHaveBeenCalled();
  });

  it("キーボードの左右の矢印で 15 分ずつ", () => {
    render(<Harness onJump={vi.fn()} />);

    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    expect(slider()).toHaveAttribute("aria-valuetext", "8:15");
    fireEvent.keyDown(slider(), { key: "ArrowLeft" });
    fireEvent.keyDown(slider(), { key: "ArrowLeft" });
    expect(slider()).toHaveAttribute("aria-valuetext", "7:45");
  });

  it("帯は指の操作をページのスクロールに渡さない（touch-action: none）", () => {
    render(<Harness onJump={vi.fn()} />);
    expect(slider()).toHaveStyle({ touchAction: "none" });
  });
});

describe("② カレンダー", () => {
  it("開くと今月。日付を押すと「その日＋① の時刻」へ移る。今日は印つき", () => {
    const onJump = vi.fn();
    render(<Harness onJump={onJump} />);

    expect(monthTitle()).toBe("2026年11月");
    expect(day(11, 10)).toHaveAttribute("aria-current", "date");
    fireEvent.pointerDown(slider(), { pointerId: 1, clientX: 30 }); // 3:00
    fireEvent.click(day(11, 3, "3:00"));
    expect(onJump).toHaveBeenCalledWith(new Date(2026, 10, 3, 3, 0).getTime());
  });

  it("まだ来ていない日は押せない（未来の日・今日の先の時刻）", () => {
    render(<Harness onJump={vi.fn()} />);

    expect(day(11, 10)).toBeEnabled(); // 今日 8:00 は過ぎている（今は 11:30）
    expect(day(11, 11)).toBeDisabled();
    fireEvent.pointerDown(slider(), { pointerId: 1, clientX: 120 }); // 12:00
    expect(day(11, 10, "12:00")).toBeDisabled();
    expect(day(11, 9, "12:00")).toBeEnabled();
  });

  it("self-hosted: ▶ は今月で押せない。◀ は 12 か月前の月まで戻れる", () => {
    render(<Harness onJump={vi.fn()} />);

    expect(screen.getByRole("button", { name: "次の月" })).toBeDisabled();
    for (let i = 0; i < 12; i++) fireEvent.click(screen.getByRole("button", { name: "前の月" }));
    expect(monthTitle()).toBe("2025年11月");
    expect(screen.getByRole("button", { name: "前の月" })).toBeDisabled();
    expect(day(11, 1)).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "次の月" }));
    expect(monthTitle()).toBe("2025年12月");
  });

  it("SaaS: 保持期間（14 日）より前の日は押せず、その月より前には戻れない", () => {
    render(<Harness maxMs={SAAS_LIMIT} onJump={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "前の月" }));
    expect(monthTitle()).toBe("2026年10月");
    expect(screen.getByRole("button", { name: "前の月" })).toBeDisabled();
    // 14 日前は 10/27 11:30。8:00 では 10/27 は押せず、10/28 から押せる
    expect(day(10, 26)).toBeDisabled();
    expect(day(10, 27)).toBeDisabled();
    expect(day(10, 28)).toBeEnabled();
  });

  it("1 日の前は曜日の分だけ空ける（2026 年 10 月 1 日は木曜）", () => {
    render(<Harness onJump={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "前の月" }));

    const cells = Array.from(screen.getByRole("group", { name: "日付" }).children);
    // 曜日の見出し 7 つの後に、空き 4 つ（日〜水）、その次が 1 日
    expect(cells.slice(0, 7).map((c) => c.textContent)).toEqual(["日", "月", "火", "水", "木", "金", "土"]);
    expect(cells.slice(7, 11).every((c) => c.textContent === "")).toBe(true);
    expect(cells[11].textContent).toBe("1");
  });
});
