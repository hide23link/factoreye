/**
 * センサー棚の「名前の語」の絞り込み（チップの並び）。語を名前に含むセンサーだけに絞る。
 * チップに、全センサー中の該当件数を添える。1 つだけ選べる（もう一度押すか「すべて」で解除）。
 * 語は「＋語を追加」で足せて、各チップの ✕ で消せる（既定の語も消せる。「既定に戻す」で戻る）。
 *
 * 【誰が使うか】EditorShelf。
 * 【引数（props）】words = 語のリスト、selected = 選択中の語、counts = 語ごとの該当件数、
 * onSelect = 選んだ（解除は null）、onAdd = 語を足す（断られたら理由を返す。足せたら null）、onRemove = 語を消す、onReset = 既定に戻す。
 */
import { useId, useState } from "react";

import { DEFAULT_WORDS, MAX_WORD_LENGTH } from "../../lib/sensor-words";

interface Props {
  words: readonly string[];
  selected: string | null;
  counts: ReadonlyMap<string, number>;
  onSelect: (word: string | null) => void;
  onAdd: (input: string) => string | null;
  onRemove: (word: string) => void;
  onReset: () => void;
}

const chipClass = (pressed: boolean) =>
  `border px-2.5 py-0.5 text-xs ${
    pressed ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300 bg-white text-gray-700"
  }`;

export function ShelfWordFilter({ words, selected, counts, onSelect, onAdd, onRemove, onReset }: Props) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const isDefault = words.length === DEFAULT_WORDS.length && words.every((w, i) => w === DEFAULT_WORDS[i]);

  const submit = () => {
    const message = onAdd(input);
    setError(message);
    if (message === null) {
      setInput("");
      setAdding(false);
    }
  };

  return (
    <div role="group" aria-label="名前の語で絞り込む" className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-gray-500">名前の語</span>
      <button
        type="button"
        aria-pressed={selected === null}
        aria-label="名前の語: すべて"
        onClick={() => onSelect(null)}
        className={`rounded-full ${chipClass(selected === null)}`}
      >
        すべて
      </button>
      {words.map((word) => (
        <span key={word} className="inline-flex items-center">
          <button
            type="button"
            aria-pressed={selected === word}
            onClick={() => onSelect(selected === word ? null : word)}
            className={`rounded-l-full ${chipClass(selected === word)}`}
          >
            {word}
            <small className="ml-1 tabular-nums opacity-70">{counts.get(word) ?? 0}</small>
          </button>
          <button
            type="button"
            aria-label={`語「${word}」を削除`}
            onClick={() => onRemove(word)}
            className={`rounded-r-full border-l-0 px-1.5 py-0.5 text-xs ${
              selected === word ? "border border-blue-600 bg-blue-600 text-white" : "border border-gray-300 bg-white text-gray-500"
            }`}
          >
            ✕
          </button>
        </span>
      ))}
      {!adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-full border border-dashed border-gray-400 px-2.5 py-0.5 text-xs text-gray-600"
        >
          ＋語を追加
        </button>
      )}
      {!isDefault && (
        <button type="button" onClick={onReset} className="text-xs text-blue-600">
          既定に戻す
        </button>
      )}
      {adding && (
        <form
          className="flex w-full items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            追加する語
          </label>
          <input
            id={inputId}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={MAX_WORD_LENGTH + 5}
            placeholder="例: 温度"
            autoFocus
            className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-2 py-1 text-xs"
          />
          <button type="submit" aria-label="語を追加" className="rounded-md border border-blue-600 bg-blue-600 px-2 py-1 text-xs font-bold text-white">
            追加
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setInput("");
              setError(null);
            }}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
          >
            やめる
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="w-full text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
