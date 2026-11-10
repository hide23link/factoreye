import { describe, expect, it } from "vitest";

import {
  LINK_VIEW_MAX_MS,
  LINK_VIEW_MIN_MS,
  atMinutes,
  calendarDays,
  canStartAt,
  chipPeriod,
  durationText,
  isAtLink,
  jumpText,
  linkPeriod,
  minutesAtRatio,
  minutesText,
  monthIndex,
  monthOf,
  oldestStart,
  panPeriod,
  periodBounds,
  periodLabel,
  pinchZoom,
  quickStarts,
  startAtPeriod,
  statusText,
  shiftMonth,
  stepPicked,
  swipeZoom,
  zoomPeriod,
  type LinkPeriod,
} from "./link-range";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 例の「今」（端末の時刻で 2026-11-10 11:30）
const NOW = new Date(2026, 10, 10, 11, 30).getTime();
const NO_LIMIT = Number.POSITIVE_INFINITY;
// SaaS（Free Tier）の表示できる最長＝測定値の保持期間（maxRangeMs(true)）
const SAAS_LIMIT = 14 * DAY;

describe("上下スワイプ・ピンチ（拡大・縮小）", () => {
  it("上へなぞると短く、下へなぞると長くなる。今を見ているときは右端（今）のまま", () => {
    const start = linkPeriod(30);
    const up = swipeZoom(start, -100, NOW, NO_LIMIT);
    const down = swipeZoom(start, 100, NOW, NO_LIMIT);
    expect(up.durationMs).toBeLessThan(30 * MINUTE);
    expect(down.durationMs).toBeGreaterThan(30 * MINUTE);
    expect(up.endMs).toBeNull();
    expect(down.endMs).toBeNull();
  });

  it("過去を見ているときは、真ん中を保つ", () => {
    const start = { durationMs: HOUR, endMs: NOW - 2 * HOUR };
    const next = swipeZoom(start, 100, NOW, NO_LIMIT);
    const center = (p: LinkPeriod) => {
      const { from, to } = periodBounds(p, NOW);
      return (from + to) / 2;
    };
    expect(center(next)).toBeCloseTo(center(start));
  });

  it("長さは 10 分〜7 日に収める", () => {
    expect(swipeZoom(linkPeriod(30), -2000, NOW, NO_LIMIT).durationMs).toBe(LINK_VIEW_MIN_MS);
    expect(swipeZoom(linkPeriod(30), 5000, NOW, NO_LIMIT).durationMs).toBe(LINK_VIEW_MAX_MS);
  });

  it("表示できる最長（maxRangeForBuild）が 7 日より短ければ、それを超えない", () => {
    expect(swipeZoom(linkPeriod(30), 5000, NOW, 3 * DAY).durationMs).toBe(3 * DAY);
  });

  it("ピンチで指の間が 2 倍に広がると、長さは半分。今を見ているときは、上下スワイプと同じく右端（今）を保つ", () => {
    expect(pinchZoom(linkPeriod(60), 100, 200, NOW, NO_LIMIT)).toEqual({ durationMs: 30 * MINUTE, endMs: null });
  });

  it("過去を見ているときのピンチは、真ん中を保つ", () => {
    const next = pinchZoom({ durationMs: HOUR, endMs: NOW - 2 * HOUR }, 100, 200, NOW, NO_LIMIT);
    expect(periodBounds(next, NOW)).toEqual({ from: NOW - 2.75 * HOUR, to: NOW - 2.25 * HOUR });
  });

  it("ホイール: カーソルの位置を保つ。今を見ていても、真ん中で拡大すると過去の表示になる", () => {
    const next = zoomPeriod(linkPeriod(60), 30 * MINUTE, 0.5, NOW, NO_LIMIT);
    expect(periodBounds(next, NOW)).toEqual({ from: NOW - 45 * MINUTE, to: NOW - 15 * MINUTE });
  });
});

describe("左右ドラッグ（時間の移動）", () => {
  it("右へなぞると過去へ（グラフの幅の分なぞると、長さ 1 つ分）", () => {
    const next = panPeriod(linkPeriod(30), 300, 300, NOW, NO_LIMIT);
    expect(next).toEqual({ durationMs: 30 * MINUTE, endMs: NOW - 30 * MINUTE });
  });

  it("今より先には行かない（今に届いたら、今を見ている状態に戻る）", () => {
    expect(panPeriod(linkPeriod(30), -300, 300, NOW, NO_LIMIT).endMs).toBeNull();
    expect(panPeriod({ durationMs: 30 * MINUTE, endMs: NOW - 10 * MINUTE }, -300, 300, NOW, NO_LIMIT).endMs).toBeNull();
  });

  it("戻れる最も古い時刻より前には行かない（self-hosted は 12 か月前の月の 1 日、SaaS は保持期間の 14 日前）", () => {
    expect(panPeriod(linkPeriod(30), 300 * 100_000, 300, NOW, NO_LIMIT).endMs).toBe(new Date(2025, 10, 1).getTime());
    expect(panPeriod(linkPeriod(30), 300 * 100_000, 300, NOW, SAAS_LIMIT).endMs).toBe(NOW - 14 * DAY);
  });

  it("時刻の指定で 6 か月前へ移った後でも、なぞると、そこから動く（30 日前へ飛ばない）", () => {
    const start = new Date(2026, 4, 10, 8, 0).getTime();
    const moved = startAtPeriod(linkPeriod(30), start, NOW, NO_LIMIT);
    expect(moved?.endMs).toBe(start + 30 * MINUTE);
    expect(panPeriod(moved as LinkPeriod, 30, 300, NOW, NO_LIMIT).endMs).toBe(start + 27 * MINUTE);
  });
});

describe("期間のボタン・時刻の指定・今に戻る", () => {
  it("期間のボタンは長さだけを変える（今なら今のまま、過去なら右端のまま）", () => {
    expect(chipPeriod(linkPeriod(30), 180, NOW, NO_LIMIT)).toEqual({ durationMs: 3 * HOUR, endMs: null });
    expect(chipPeriod({ durationMs: HOUR, endMs: NOW - DAY }, 30, NOW, NO_LIMIT)).toEqual({ durationMs: 30 * MINUTE, endMs: NOW - DAY });
  });

  it("時刻の指定: その時刻から、長さは今のまま", () => {
    const start = new Date(2026, 10, 10, 8, 0).getTime();
    expect(startAtPeriod(linkPeriod(30), start, NOW, NO_LIMIT)).toEqual({ durationMs: 30 * MINUTE, endMs: start + 30 * MINUTE });
  });

  it("時刻の指定: 未来の時刻は null（「まだ来ていない時刻です」）", () => {
    expect(startAtPeriod(linkPeriod(30), NOW + MINUTE, NOW, NO_LIMIT)).toBeNull();
    expect(startAtPeriod(linkPeriod(30), NOW, NOW, NO_LIMIT)).toBeNull();
  });

  it("時刻の指定: 終わりが今を越えるなら、今を見ている状態になる", () => {
    expect(startAtPeriod(linkPeriod(30), NOW - 10 * MINUTE, NOW, NO_LIMIT)?.endMs).toBeNull();
  });

  it("リンクの設定のままかを見分ける（「今に戻る」を出すか）", () => {
    expect(isAtLink(linkPeriod(30), 30)).toBe(true);
    expect(isAtLink({ durationMs: HOUR, endMs: null }, 30)).toBe(false);
    expect(isAtLink({ durationMs: 30 * MINUTE, endMs: NOW - HOUR }, 30)).toBe(false);
  });
});

describe("表示の文字", () => {
  it("長さ・期間・状態の行", () => {
    expect(durationText(30 * MINUTE)).toBe("30 分");
    expect(durationText(90 * MINUTE)).toBe("1.5 時間");
    expect(durationText(2 * DAY)).toBe("2 日");
    expect(periodLabel(linkPeriod(30), NOW)).toBe("直近 30 分");
    expect(periodLabel({ durationMs: 30 * MINUTE, endMs: new Date(2026, 10, 10, 8, 30).getTime() }, NOW)).toBe("8:00〜8:30");
    expect(statusText(linkPeriod(30), NOW, NOW)).toBe("11:30 更新・自動で更新中");
    expect(statusText({ durationMs: HOUR, endMs: NOW - 2 * HOUR }, NOW, NOW)).toBe("2 時間前まで・更新を止めています");
  });

  it("移ったときの知らせ: 今日は「8:00 から表示」、ほかの日は「11/3 8:00 から表示」、今を越えるなら「直近 ◯ を表示（今を越えるため）」", () => {
    const today8 = new Date(2026, 10, 10, 8, 0).getTime();
    const nov3 = new Date(2026, 10, 3, 8, 0).getTime();
    expect(jumpText({ durationMs: 30 * MINUTE, endMs: today8 + 30 * MINUTE }, today8, NOW)).toBe("8:00 から表示");
    expect(jumpText({ durationMs: 30 * MINUTE, endMs: nov3 + 30 * MINUTE }, nov3, NOW)).toBe("11/3 8:00 から表示");
    expect(jumpText(linkPeriod(30), NOW - 10 * MINUTE, NOW)).toBe("直近 30 分を表示（今を越えるため）");
  });
});

describe("時刻の指定のシート", () => {
  it("近道は 1 時間前・3 時間前・今日 8:00・昨日 8:00・昨日 13:00", () => {
    expect(quickStarts(NOW)).toEqual([
      { label: "1 時間前", startMs: NOW - HOUR },
      { label: "3 時間前", startMs: NOW - 3 * HOUR },
      { label: "今日 8:00", startMs: new Date(2026, 10, 10, 8, 0).getTime() },
      { label: "昨日 8:00", startMs: new Date(2026, 10, 9, 8, 0).getTime() },
      { label: "昨日 13:00", startMs: new Date(2026, 10, 9, 13, 0).getTime() },
    ]);
  });

  it("時刻の帯: 位置を 15 分刻みにする（0:00〜23:45）", () => {
    expect(minutesAtRatio(0)).toBe(0);
    expect(minutesAtRatio(8 / 24)).toBe(480);
    expect(minutesAtRatio((8 * 60 + 7) / 1440)).toBe(480); // 8:07 → 8:00
    expect(minutesAtRatio((8 * 60 + 8) / 1440)).toBe(495); // 8:08 → 8:15
    expect(minutesAtRatio(1)).toBe(1425);
    expect(minutesAtRatio(-0.2)).toBe(0);
    expect(minutesText(495)).toBe("8:15");
    expect(minutesText(0)).toBe("0:00");
  });

  it("時刻の帯: 矢印で 15 分ずつ。0:00 と 23:45 で止まる", () => {
    expect(stepPicked(480, 1)).toBe(495);
    expect(stepPicked(480, -1)).toBe(465);
    expect(stepPicked(0, -1)).toBe(0);
    expect(stepPicked(1425, 1)).toBe(1425);
  });

  it("日付＋時刻、押せるか（未来・今日の先の時刻・保持期間より前は押せない）", () => {
    const nov3 = new Date(2026, 10, 3).getTime();
    expect(atMinutes(nov3, 480)).toBe(new Date(2026, 10, 3, 8, 0).getTime());
    const oldest = oldestStart(NOW, SAAS_LIMIT);
    expect(canStartAt(atMinutes(nov3, 480), NOW, oldest)).toBe(true);
    expect(canStartAt(new Date(2026, 10, 10, 13, 0).getTime(), NOW, oldest)).toBe(false); // 今日の先の時刻
    expect(canStartAt(new Date(2026, 10, 11, 8, 0).getTime(), NOW, oldest)).toBe(false); // 明日
    // SaaS は 14 日前（10/27 11:30）より前は押せない
    expect(canStartAt(new Date(2026, 9, 27, 13, 0).getTime(), NOW, oldest)).toBe(true);
    expect(canStartAt(new Date(2026, 9, 27, 8, 0).getTime(), NOW, oldest)).toBe(false);
    expect(canStartAt(new Date(2026, 9, 26, 13, 0).getTime(), NOW, oldest)).toBe(false);
  });

  it("戻れる最も古い月: self-hosted は 12 か月前、SaaS は 14 日前の月", () => {
    expect(monthOf(oldestStart(NOW, NO_LIMIT))).toEqual({ year: 2025, month: 10 });
    expect(monthOf(oldestStart(NOW, SAAS_LIMIT))).toEqual({ year: 2026, month: 9 });
    expect(monthIndex({ year: 2026, month: 10 }) - monthIndex({ year: 2025, month: 10 })).toBe(12);
  });

  it("月を前後に動かす（年をまたぐ）。表は 1 日の曜日の分だけ空ける", () => {
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth({ year: 2025, month: 11 }, 1)).toEqual({ year: 2026, month: 0 });
    const november = calendarDays({ year: 2026, month: 10 });
    expect(november.blanks).toBe(0); // 2026-11-01 は日曜
    expect(november.days).toHaveLength(30);
    expect(november.days[2]).toBe(new Date(2026, 10, 3).getTime());
    expect(calendarDays({ year: 2026, month: 1 })).toMatchObject({ blanks: 0 }); // 2026-02-01 は日曜
    expect(calendarDays({ year: 2026, month: 9 }).blanks).toBe(4); // 2026-10-01 は木曜
  });
});
