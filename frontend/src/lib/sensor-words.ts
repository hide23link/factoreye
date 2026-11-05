/**
 * センサー棚の「名前の語」で絞り込むチップの、語のリストと選択中の語（追加・削除・保存・復元）。画面に依存しない関数。
 *
 * - 語は、利用者が足したり消したりできる。既定は「電圧」「電流」「電位」
 * - 語のリストと選択中の語は localStorage に保存する。localStorage が使えない環境（プライベートモード・容量超過・
 *   保存先なし）でも、例外を握りつぶして、保存しないだけで動く。保存した値が壊れていたら、既定に戻す
 *
 * 【誰が使うか】EditorShelf（読み込み・保存・追加・削除）、ShelfWordFilter（入力の検査）。
 */

export const DEFAULT_WORDS: readonly string[] = ["電圧", "電流", "電位"];
/** 語の最大の長さ（文字数） */
export const MAX_WORD_LENGTH = 20;
const STORAGE_KEY = "factoreye.sensorShelfWords";

export interface WordFilterState {
  words: string[];
  /** 絞り込みに使っている語。words のどれか、または null（絞り込まない） */
  selected: string | null;
}

export const defaultWordFilter = (): WordFilterState => ({ words: [...DEFAULT_WORDS], selected: null });

/** 語を比べるときは、大文字小文字を区別しない（絞り込みと同じ） */
const sameWord = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type AddWordResult = { ok: true; words: string[] } | { ok: false; message: string };

/** 語を足す。前後の空白を除き、空・長すぎる・重複は断る */
export function addWord(words: readonly string[], input: string): AddWordResult {
  const word = input.trim();
  if (word === "") return { ok: false, message: "語を入力してください" };
  if (word.length > MAX_WORD_LENGTH) return { ok: false, message: `語は ${MAX_WORD_LENGTH} 文字までです` };
  if (words.some((existing) => sameWord(existing, word))) return { ok: false, message: "同じ語がすでにあります" };
  return { ok: true, words: [...words, word] };
}

/** 語を消す。選択中の語を消したら、選択も外す */
export function removeWord(state: WordFilterState, word: string): WordFilterState {
  return {
    words: state.words.filter((existing) => existing !== word),
    selected: state.selected === word ? null : state.selected,
  };
}

/** 保存した値が、正しい形か（語が文字列で、空でなく、長すぎず、重複がなく、選択が語のどれかであること） */
function isValidState(value: unknown): value is WordFilterState {
  if (typeof value !== "object" || value === null) return false;
  const { words, selected } = value as Record<string, unknown>;
  if (!Array.isArray(words) || !words.every((w) => typeof w === "string")) return false;
  const valid = words.every(
    (w, index) =>
      w.trim() === w && w !== "" && w.length <= MAX_WORD_LENGTH && words.findIndex((other) => sameWord(other, w)) === index,
  );
  return valid && (selected === null || (typeof selected === "string" && words.includes(selected)));
}

/** 保存した状態を読む。無い・壊れている・使えない環境では、既定 */
export function loadWordFilter(): WordFilterState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultWordFilter();
    const parsed: unknown = JSON.parse(raw);
    return isValidState(parsed) ? { words: [...parsed.words], selected: parsed.selected } : defaultWordFilter();
  } catch {
    return defaultWordFilter();
  }
}

/** 状態を保存する（使えない環境では何もしない） */
export function saveWordFilter(state: WordFilterState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 保存できなくても、画面は動かす
  }
}
