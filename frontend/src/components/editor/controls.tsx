/**
 * 設定パネルで使う小さな入力部品（区切り、選択ボタン、スイッチ、数値）。
 * どれも「変更したらすぐ onChange を呼ぶ」作り（保存ボタンは無い）。
 * ただし数値の入力欄は、打っている途中で保存しないよう、確定（入力欄を離れる／Enter／＋－ボタン）で呼ぶ。
 *
 * 【誰が使うか】SettingsPanel、WidgetSettings 各種。
 */
import { useId, useState, type ReactNode } from "react";

import { isImeComposing } from "../../lib/ime";

/**
 * 補足説明の ⓘ ボタン。押すと説明を開き、もう一度押すと閉じる（普段は文字を出さず、画面を広く使う）。
 * 説明の文は、ボタンの下に出す。open / onToggle で開閉を呼び出し側が持つ。
 */
export function InfoButton({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={`${label}の説明`}
      aria-expanded={open}
      title="説明を見る"
      onClick={onToggle}
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-bold leading-none ${
        open ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300 text-gray-500 hover:border-blue-600 hover:text-blue-600"
      }`}
    >
      i
    </button>
  );
}

/** 見出し付きの区切り。note（補足）は ⓘ を押したときだけ出す */
export function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  const [noteOpen, setNoteOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2 border-b border-gray-200 py-3 last:border-b-0">
      <div className="flex items-center gap-1.5">
        <h4 className="min-w-0 truncate text-xs font-bold tracking-wide text-gray-500" title={title}>
          {title}
        </h4>
        {note && <InfoButton label={title} open={noteOpen} onToggle={() => setNoteOpen((o) => !o)} />}
      </div>
      {note && noteOpen && <p className="rounded-md bg-blue-50 px-2 py-1.5 text-xs text-gray-600">{note}</p>}
      {children}
    </section>
  );
}

/** 選択ボタン（どれか1つ）。選択肢の value は文字列か数値 */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-full overflow-hidden rounded-md border border-gray-300 bg-white">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={`min-w-0 flex-1 whitespace-nowrap border-r border-gray-300 px-2 py-1 text-sm last:border-r-0 ${
            option.value === value ? "bg-blue-50 font-semibold text-blue-700" : "text-gray-700 hover:bg-gray-50"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** オン／オフのスイッチ */
export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className={disabled ? "text-gray-400" : "text-gray-800"}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
          checked ? "bg-blue-600" : "bg-gray-300"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
        />
      </button>
    </div>
  );
}

/**
 * 数値の入力。空欄は null（未指定）。min / max の外は、確定のときに範囲内へ丸める。
 * step を渡すと、両側に「−」「＋」ボタンを付ける。
 */
export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step,
  placeholder,
  unit,
  allowEmpty = false,
}: {
  label: string;
  value: number | null;
  onCommit: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  unit?: string;
  /** 空欄を「未指定」として確定できるか（縦軸の最小・最大など） */
  allowEmpty?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));

  const clampValue = (n: number) => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));

  const commitDraft = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === "") {
      if (allowEmpty && value !== null) onCommit(null);
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return;
    const next = clampValue(parsed);
    if (next !== value) onCommit(next);
  };

  const bump = (direction: 1 | -1) => {
    if (step === undefined) return;
    setDraft(null);
    onCommit(clampValue((value ?? 0) + direction * step));
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <div className="inline-flex items-stretch overflow-hidden rounded-md border border-gray-300">
        {step !== undefined && (
          <button type="button" aria-label={`${label}を減らす`} onClick={() => bump(-1)} className="w-9 bg-gray-50 text-lg hover:bg-blue-50">
            −
          </button>
        )}
        <input
          id={id}
          type="number"
          aria-label={label}
          value={shown}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isImeComposing(e)) commitDraft();
          }}
          className={`min-w-0 px-2 py-1 text-center ${step !== undefined ? "w-24 font-bold" : "w-full"}`}
        />
        {step !== undefined && (
          <button type="button" aria-label={`${label}を増やす`} onClick={() => bump(1)} className="w-9 bg-gray-50 text-lg hover:bg-blue-50">
            ＋
          </button>
        )}
      </div>
      {unit && <span className="text-gray-500">{unit}</span>}
    </div>
  );
}
