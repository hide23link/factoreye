/**
 * リンクの画面の「時刻を指定」のシート（画面の下から出る）。日時を選び、「この時刻から」グラフを出す。長さは今のまま。
 * 近道は「今日 8:00」「今日 13:00」「昨日 8:00」。日時の欄は 5 分刻み（スマホでは日時のダイヤルになる）。
 *
 * 【誰が使うか】LinkScreen が、上の期間の表示を押したときに出す。
 * 【引数（props）】startMs = 今の表示の開始時刻（欄の初期値）、now = 今の時刻（選べる範囲）、
 * onApply = 「表示」を押したとき（選んだ時刻。未来なら LinkScreen が「まだ来ていない時刻です」を出す）、onCancel = 「やめる」。
 */
import { useId, useState } from "react";

import { earliestStart, floorToFiveMinutes, fromLocalInput, quickStarts, toLocalInput } from "../../lib/link-range";

export function LinkTimeSheet({
  startMs,
  now,
  onApply,
  onCancel,
}: {
  startMs: number;
  now: number;
  onApply: (startMs: number) => void;
  onCancel: () => void;
}) {
  const inputId = useId();
  const [value, setValue] = useState(() => toLocalInput(floorToFiveMinutes(startMs)));

  return (
    <div
      role="dialog"
      aria-label="時刻を指定"
      className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 rounded-t-2xl border-t border-gray-200 bg-white p-3.5 text-xs shadow-[0_-8px_24px_rgba(0,0,0,0.15)]"
    >
      <b className="text-sm">時刻を指定</b>
      <label htmlFor={inputId}>この時刻から</label>
      <input
        id={inputId}
        type="datetime-local"
        autoFocus
        value={value}
        min={toLocalInput(earliestStart(now))}
        max={toLocalInput(now)}
        step={300}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm"
      />
      <div role="group" aria-label="よく使う時刻" className="flex flex-wrap gap-1.5">
        {quickStarts(now).map((quick) => (
          <button
            key={quick.label}
            type="button"
            onClick={() => setValue(quick.value)}
            className="rounded-full border border-gray-200 px-2.5 py-0.5 text-xs"
          >
            {quick.label}
          </button>
        ))}
      </div>
      <span className="text-gray-500">長さは今のまま（下の期間のボタンでも変えられる）</span>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-gray-200 px-2.5 py-1 text-sm">
          やめる
        </button>
        <button
          type="button"
          onClick={() => {
            const start = fromLocalInput(value);
            if (start === null) onCancel();
            else onApply(start);
          }}
          className="rounded-md bg-blue-600 px-2.5 py-1 text-sm font-bold text-white"
        >
          表示
        </button>
      </div>
    </div>
  );
}
