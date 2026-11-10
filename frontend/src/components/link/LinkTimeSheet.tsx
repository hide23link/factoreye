/**
 * リンクの画面の「この時刻から表示」のシート（画面の下から出る）。長さは今のまま、選んだ時刻からグラフを出す。
 *
 * - 近道 5 つ（1 時間前・3 時間前・今日 8:00・昨日 8:00・昨日 13:00）: 押すとすぐ移る。未来になるものは押せない
 * - ① 時刻の帯（0:00〜24:00）: 押すか、なぞって 15 分刻みで時刻を選ぶ。ここでは移らない
 * - ② カレンダー: 日付を押すと「その日＋① の時刻」へすぐ移る。◀ ▶ で月を変える
 * 開くと ✕ にフォーカスし、Esc で閉じる。日付・時刻は端末の時刻。戻れる最も古い時刻は oldestStart（SaaS は保持期間の 14 日、self-hosted は 12 か月前の月）。
 *
 * 【誰が使うか】LinkScreen が、上の期間の表示（🕘）を押したときに出す。
 * 【引数（props）】now = シートを開いた時刻、maxMs = 表示できる最長（maxRangeForBuild）、
 * pickedMinutes = ① で選んでいる時刻（0:00 からの分。閉じても LinkScreen が覚えておく）、onPick = ① で選んだとき、
 * onJump = 移るとき（開始の時刻）、onClose = ✕ を押したとき。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import {
  LAST_PICK_MINUTES,
  atMinutes,
  calendarDays,
  canStartAt,
  dayStart,
  minutesAtRatio,
  minutesText,
  monthIndex,
  monthOf,
  oldestStart,
  quickStarts,
  shiftMonth,
  stepPicked,
  type CalendarMonth,
} from "../../lib/link-range";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
/** 帯の目盛り（1〜23 時）。6 時間ごとは長くする */
const TICK_HOURS = Array.from({ length: 23 }, (_, i) => i + 1);

export function LinkTimeSheet({
  now,
  maxMs,
  pickedMinutes,
  onPick,
  onJump,
  onClose,
}: {
  now: number;
  maxMs: number;
  pickedMinutes: number;
  onPick: (minutes: number) => void;
  onJump: (startMs: number) => void;
  onClose: () => void;
}) {
  const oldestMs = oldestStart(now, maxMs);
  // 開いたら ✕ にフォーカスする（キーボード・読み上げで、シートの中から操作を始められるように）
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => closeButton.current?.focus(), []);

  return (
    <div
      role="dialog"
      aria-label="この時刻から表示"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="absolute inset-x-0 bottom-0 z-10 flex max-h-full flex-col gap-2 overflow-y-auto rounded-t-2xl border-t border-gray-200 bg-white p-3.5 text-xs shadow-[0_-8px_24px_rgba(0,0,0,0.15)]"
    >
      <div className="flex items-center justify-between">
        <b className="text-sm">この時刻から表示</b>
        <button ref={closeButton} type="button" aria-label="閉じる" onClick={onClose} className="px-1.5 py-0.5 text-base text-gray-500">
          ✕
        </button>
      </div>
      <div role="group" aria-label="近道" className="flex gap-1.5 overflow-x-auto">
        {quickStarts(now).map((quick, index) => (
          <button
            key={quick.label}
            type="button"
            disabled={!canStartAt(quick.startMs, now, oldestMs)}
            // 「1 時間前」などは、開いた時刻ではなく押した時刻から数える（開いたまま置いても、ずれないように）
            onClick={() => onJump(quickStarts(Date.now())[index].startMs)}
            className="shrink-0 rounded-full border border-gray-200 px-3 py-1.5 text-xs disabled:opacity-40"
          >
            {quick.label}
          </button>
        ))}
      </div>
      <TimeTrack pickedMinutes={pickedMinutes} onPick={onPick} />
      <div className="text-gray-500">② 日付を押すと、その日のその時刻へ移る</div>
      <MonthCalendar now={now} oldestMs={oldestMs} pickedMinutes={pickedMinutes} onJump={onJump} />
      <span className="text-[11px] text-gray-500">近道は押すとすぐ移る。長さは今のまま</span>
    </div>
  );
}

/** ① 時刻の帯。押すか、なぞって 15 分刻みで選ぶ。キーボードは左右の矢印で 15 分ずつ */
function TimeTrack({ pickedMinutes, onPick }: { pickedMinutes: number; onPick: (minutes: number) => void }) {
  // なぞっている間だけ true（指を離した後の pointermove では選ばない）
  const scrubbing = useRef(false);
  const pickAt = (e: ReactPointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    onPick(minutesAtRatio((e.clientX - box.left) / Math.max(box.width, 1)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onPick(stepPicked(pickedMinutes, e.key === "ArrowRight" ? 1 : -1));
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="text-gray-500">
        ① 時刻 <b className="text-lg tabular-nums text-gray-900">{minutesText(pickedMinutes)}</b> から（押すか、なぞる）
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="時刻を選ぶ"
        aria-valuemin={0}
        aria-valuemax={LAST_PICK_MINUTES}
        aria-valuenow={pickedMinutes}
        aria-valuetext={minutesText(pickedMinutes)}
        onPointerDown={(e) => {
          scrubbing.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          pickAt(e);
        }}
        onPointerMove={(e) => {
          if (scrubbing.current) pickAt(e);
        }}
        onPointerUp={() => (scrubbing.current = false)}
        onPointerCancel={() => (scrubbing.current = false)}
        onKeyDown={onKeyDown}
        // 帯をなぞる指で、ページのスクロールやブラウザの拡大が動かないように
        style={{ touchAction: "none" }}
        className="relative h-11 cursor-ew-resize overflow-hidden rounded-[10px] border border-gray-200 bg-gray-50"
      >
        <svg viewBox="0 0 240 40" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0 h-full w-full">
          {TICK_HOURS.map((hour) => (
            <line
              key={hour}
              x1={(240 * hour) / 24}
              x2={(240 * hour) / 24}
              y1={hour % 6 === 0 ? 4 : 26}
              y2={40}
              stroke="#e5e7eb"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <div
          className="absolute -bottom-px -top-px -ml-[1.5px] w-[3px] bg-blue-600 shadow-[0_0_0_3px_#dbeafe]"
          style={{ left: `${(pickedMinutes / (24 * 60)) * 100}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-500">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24 時</span>
      </div>
    </div>
  );
}

/** ② 月ごとのカレンダー。開いたときは今月。▶ は今月で、◀ は戻れる最も古い月で押せない */
function MonthCalendar({
  now,
  oldestMs,
  pickedMinutes,
  onJump,
}: {
  now: number;
  oldestMs: number;
  pickedMinutes: number;
  onJump: (startMs: number) => void;
}) {
  const [view, setView] = useState<CalendarMonth>(() => monthOf(now));
  const { blanks, days } = calendarDays(view);
  const today = dayStart(now);
  // 読み上げ用の「8時00分」（モックと同じ書き方）
  const time = `${Math.floor(pickedMinutes / 60)}時${String(pickedMinutes % 60).padStart(2, "0")}分`;

  return (
    <>
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="前の月"
          disabled={monthIndex(view) <= monthIndex(monthOf(oldestMs))}
          onClick={() => setView(shiftMonth(view, -1))}
          className="rounded-lg border border-gray-200 px-3.5 py-1 text-[13px] disabled:opacity-35"
        >
          ◀
        </button>
        <b className="text-[13px]">
          {view.year}年{view.month + 1}月
        </b>
        <button
          type="button"
          aria-label="次の月"
          disabled={monthIndex(view) >= monthIndex(monthOf(now))}
          onClick={() => setView(shiftMonth(view, 1))}
          className="rounded-lg border border-gray-200 px-3.5 py-1 text-[13px] disabled:opacity-35"
        >
          ▶
        </button>
      </div>
      <div role="group" aria-label="日付" className="grid grid-cols-7 gap-[3px] text-center">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday} className="text-[10px] text-gray-500">
            {weekday}
          </span>
        ))}
        {Array.from({ length: blanks }, (_, i) => (
          <span key={`blank-${i}`} />
        ))}
        {days.map((day) => {
          const start = atMinutes(day, pickedMinutes);
          const date = new Date(day).getDate();
          return (
            <button
              key={day}
              type="button"
              disabled={!canStartAt(start, now, oldestMs)}
              aria-label={`${view.month + 1}月${date}日 ${time}から`}
              aria-current={day === today ? "date" : undefined}
              onClick={() => onJump(start)}
              className={`rounded-lg border py-[3px] text-xs tabular-nums disabled:text-gray-200 ${day === today ? "border-blue-600" : "border-transparent"}`}
            >
              {date}
            </button>
          );
        })}
      </div>
    </>
  );
}
