import { describe, expect, it } from "vitest";

import {
  LINK_VIEW_MAX_MS,
  LINK_VIEW_MIN_MS,
  chipPeriod,
  durationText,
  fromLocalInput,
  isAtLink,
  linkPeriod,
  panPeriod,
  periodBounds,
  periodLabel,
  pinchZoom,
  quickStarts,
  startAtPeriod,
  statusText,
  swipeZoom,
  toLocalInput,
  zoomPeriod,
  type LinkPeriod,
} from "./link-range";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 例の「今」（端末の時刻で 2026-11-10 11:30）
const NOW = new Date(2026, 10, 10, 11, 30).getTime();
const NO_LIMIT = Number.POSITIVE_INFINITY;

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

  it("ピンチで指の間が 2 倍に広がると、長さは半分", () => {
    expect(pinchZoom(linkPeriod(60), 100, 200, NOW, NO_LIMIT).durationMs).toBe(30 * MINUTE);
  });

  it("ホイール: カーソルの位置を保つ。今を見ていても、真ん中で拡大すると過去の表示になる", () => {
    const next = zoomPeriod(linkPeriod(60), 30 * MINUTE, 0.5, NOW, NO_LIMIT);
    expect(periodBounds(next, NOW)).toEqual({ from: NOW - 45 * MINUTE, to: NOW - 15 * MINUTE });
  });
});

describe("左右ドラッグ（時間の移動）", () => {
  it("右へなぞると過去へ（グラフの幅の分なぞると、長さ 1 つ分）", () => {
    const next = panPeriod(linkPeriod(30), 300, 300, NOW);
    expect(next).toEqual({ durationMs: 30 * MINUTE, endMs: NOW - 30 * MINUTE });
  });

  it("今より先には行かない（今に届いたら、今を見ている状態に戻る）", () => {
    expect(panPeriod(linkPeriod(30), -300, 300, NOW).endMs).toBeNull();
    expect(panPeriod({ durationMs: 30 * MINUTE, endMs: NOW - 10 * MINUTE }, -300, 300, NOW).endMs).toBeNull();
  });

  it("30 日より前には行かない", () => {
    expect(panPeriod(linkPeriod(30), 300 * 10_000, 300, NOW).endMs).toBe(NOW - 30 * DAY);
  });
});

describe("期間のボタン・時刻の指定・今に戻る", () => {
  it("期間のボタンは長さだけを変える（今なら今のまま、過去なら右端のまま）", () => {
    expect(chipPeriod(linkPeriod(30), 180, NOW, NO_LIMIT)).toEqual({ durationMs: 3 * HOUR, endMs: null });
    expect(chipPeriod({ durationMs: HOUR, endMs: NOW - DAY }, 30, NOW, NO_LIMIT)).toEqual({ durationMs: 30 * MINUTE, endMs: NOW - DAY });
  });

  it("時刻の指定: その時刻から、長さは今のまま", () => {
    const start = new Date(2026, 10, 10, 8, 0).getTime();
    expect(startAtPeriod(linkPeriod(30), start, NOW)).toEqual({ durationMs: 30 * MINUTE, endMs: start + 30 * MINUTE });
  });

  it("時刻の指定: 未来の時刻は null（「まだ来ていない時刻です」）", () => {
    expect(startAtPeriod(linkPeriod(30), NOW + MINUTE, NOW)).toBeNull();
    expect(startAtPeriod(linkPeriod(30), NOW, NOW)).toBeNull();
  });

  it("時刻の指定: 終わりが今を越えるなら、今を見ている状態になる", () => {
    expect(startAtPeriod(linkPeriod(30), NOW - 10 * MINUTE, NOW)?.endMs).toBeNull();
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

  it("日時の欄の値と時刻を行き来できる。近道は今日 8:00・今日 13:00・昨日 8:00", () => {
    expect(toLocalInput(NOW)).toBe("2026-11-10T11:30");
    expect(fromLocalInput("2026-11-10T11:30")).toBe(NOW);
    expect(fromLocalInput("")).toBeNull();
    expect(quickStarts(NOW).map((q) => q.value)).toEqual(["2026-11-10T08:00", "2026-11-10T13:00", "2026-11-09T08:00"]);
  });
});
