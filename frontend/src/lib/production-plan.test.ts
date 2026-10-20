import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCHEDULE,
  forecastTone,
  planPerWorkHour,
  planTone,
  planUntil,
  scheduleFromConfig,
  summarizeProduction,
  totalWorkMinutes,
  workMinutesBetween,
  type CountBucket,
} from "./production-plan";

const at = (hour: number, minute = 0) => hour * 60 + minute;

describe("scheduleFromConfig", () => {
  it("未設定なら 8〜17 時・昼休み 60 分", () => {
    expect(scheduleFromConfig({})).toEqual(DEFAULT_SCHEDULE);
  });

  it("終了が開始以前なら、開始の 1 時間後に直す", () => {
    expect(scheduleFromConfig({ workStartHour: 10, workEndHour: 9 }).endHour).toBe(11);
  });

  it("範囲外の値を丸める", () => {
    expect(scheduleFromConfig({ workStartHour: -3, workEndHour: 99, breakMinutes: 999 })).toEqual({
      startHour: 0,
      endHour: 24,
      breakMinutes: 180,
    });
  });
});

describe("稼働時間と計画", () => {
  it("8〜17 時・昼休み 60 分の稼働時間は 8 時間", () => {
    expect(totalWorkMinutes(DEFAULT_SCHEDULE)).toBe(480);
  });

  it("昼休みなしなら 9 時間", () => {
    expect(totalWorkMinutes({ ...DEFAULT_SCHEDULE, breakMinutes: 0 })).toBe(540);
  });

  it("目標 1200 なら 1 時間あたり 150（休憩を除く稼働時間で割る）", () => {
    expect(planPerWorkHour(1200, DEFAULT_SCHEDULE)).toBe(150);
  });

  it("計画は稼働している時間にだけ増える（昼休み中は止まる）", () => {
    expect(planUntil(1200, DEFAULT_SCHEDULE, at(10))).toBe(300);
    expect(planUntil(1200, DEFAULT_SCHEDULE, at(12, 30))).toBe(600);
    expect(planUntil(1200, DEFAULT_SCHEDULE, at(13))).toBe(600);
    expect(planUntil(1200, DEFAULT_SCHEDULE, at(14))).toBe(750);
    expect(planUntil(1200, DEFAULT_SCHEDULE, at(23))).toBe(1200);
  });

  it("始業前の計画は 0", () => {
    expect(planUntil(1200, DEFAULT_SCHEDULE, at(7))).toBe(0);
  });

  it("休憩 45 分は 12:45 まで", () => {
    const s = { ...DEFAULT_SCHEDULE, breakMinutes: 45 };
    expect(workMinutesBetween(at(12), at(13), s)).toBe(15);
  });
});

// 8 時から 13:20 まで、10 分ごとに 25 個ずつ作った（昼休みの間は 0）
function steadyBuckets(until: number): CountBucket[] {
  const out: CountBucket[] = [];
  for (let m = at(8); m < until; m += 10) {
    const onBreak = m >= at(12) && m < at(13);
    out.push({ startMinute: m, count: onBreak ? 0 : 25 });
  }
  return out;
}

describe("summarizeProduction", () => {
  const now = at(13, 20);
  const buckets = steadyBuckets(now);
  const summary = summarizeProduction(1200, DEFAULT_SCHEDULE, buckets, now);

  it("実績は区間の合計", () => {
    // 稼働 4 時間 20 分 = 26 区間 × 25
    expect(summary.actual).toBe(26 * 25);
  });

  it("計画との差（実績 − 計画）", () => {
    // 計画: 稼働 4 時間 20 分 × 150 = 650
    expect(summary.planNow).toBeCloseTo(650);
    expect(summary.diff).toBeCloseTo(0);
  });

  it("見込みは今のペースを終業まで延長する", () => {
    // ペース 650 / 260 分 × 残り 220 分 = 550 → 650 + 550
    expect(summary.forecast).toBeCloseTo(1200);
    expect(summary.forecastPercent).toBeCloseTo(100);
  });

  it("止まらず作っていれば稼働率 100%・停止 0 分（昼休みは数えない）", () => {
    expect(summary.uptimePercent).toBe(100);
    expect(summary.stopMinutes).toBe(0);
  });

  it("時間別の行は 8〜16 時で、昼休みの時間は break", () => {
    expect(summary.hours.map((h) => h.hour)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(summary.hours.find((h) => h.hour === 12)?.state).toBe("break");
    expect(summary.hours.find((h) => h.hour === 11)?.state).toBe("done");
    expect(summary.hours.find((h) => h.hour === 13)?.state).toBe("now");
    expect(summary.hours.find((h) => h.hour === 15)?.state).toBe("future");
    expect(summary.hours.find((h) => h.hour === 9)).toMatchObject({ plan: 150, actual: 150 });
  });

  it("生産が 0 の 10 分区間を停止時間として数える", () => {
    const stopped = buckets.map((b) => (b.startMinute === at(9) || b.startMinute === at(9, 10) ? { ...b, count: 0 } : b));
    const s = summarizeProduction(1200, DEFAULT_SCHEDULE, stopped, now);
    expect(s.stopMinutes).toBe(20);
    expect(s.uptimePercent).toBe(Math.round((1 - 2 / 26) * 100));
  });

  it("測定値が無い区間（配列に含まれない）も停止として数える", () => {
    const missing = buckets.filter((b) => b.startMinute !== at(10));
    expect(summarizeProduction(1200, DEFAULT_SCHEDULE, missing, now).stopMinutes).toBe(10);
  });

  it("始業前は、ペースが分からないので見込みは出さない（null）・稼働率も null", () => {
    const s = summarizeProduction(1200, DEFAULT_SCHEDULE, [], at(7));
    expect(s.forecast).toBeNull();
    expect(s.forecastPercent).toBeNull();
    expect(s.uptimePercent).toBeNull();
    expect(s.hours.every((h) => h.state !== "done")).toBe(true);
  });

  it("稼働が 30 分未満の間（始業直後）は見込みを出さず、30 分になったら出す", () => {
    const early = summarizeProduction(1200, DEFAULT_SCHEDULE, steadyBuckets(at(8, 20)), at(8, 20));
    expect(early.forecast).toBeNull();
    const enough = summarizeProduction(1200, DEFAULT_SCHEDULE, steadyBuckets(at(8, 30)), at(8, 30));
    expect(enough.forecast).not.toBeNull();
  });

  it("勤務時間の外の生産は実績に入れない", () => {
    const s = summarizeProduction(1200, DEFAULT_SCHEDULE, [{ startMinute: at(6), count: 99 }], now);
    expect(s.actual).toBe(0);
  });

  it("終業後は、見込みが実績に一致する", () => {
    const s = summarizeProduction(1200, DEFAULT_SCHEDULE, steadyBuckets(at(17)), at(18));
    expect(s.forecast).toBeCloseTo(s.actual);
    expect(s.hours.every((h) => h.state === "done" || h.state === "break")).toBe(true);
  });

  it("目標が 0 でも割り算で壊れない", () => {
    const s = summarizeProduction(0, DEFAULT_SCHEDULE, buckets, now);
    expect(s.achievementPercent).toBe(0);
    expect(s.forecastPercent).toBe(0);
  });
});

describe("評価の色", () => {
  it("先行は ok、目標の 5% 以内の遅れは warn、それ以上は crit", () => {
    expect(planTone(10, 1000)).toBe("ok");
    expect(planTone(-49, 1000)).toBe("warn");
    expect(planTone(-50, 1000)).toBe("crit");
  });

  it("見込みは 100% 以上 ok、95% 以上 warn", () => {
    expect(forecastTone(100)).toBe("ok");
    expect(forecastTone(96)).toBe("warn");
    expect(forecastTone(80)).toBe("crit");
  });
});
