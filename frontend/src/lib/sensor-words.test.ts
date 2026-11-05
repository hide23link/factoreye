import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORDS,
  MAX_WORD_LENGTH,
  addWord,
  defaultWordFilter,
  loadWordFilter,
  removeWord,
  saveWordFilter,
} from "./sensor-words";

const KEY = "factoreye.sensorShelfWords";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("addWord", () => {
  it("前後の空白を除いて、末尾に足す", () => {
    expect(addWord(["電圧"], "  温度 ")).toEqual({ ok: true, words: ["電圧", "温度"] });
  });

  it("空・空白だけの語は断る", () => {
    expect(addWord(["電圧"], "   ")).toEqual({ ok: false, message: "語を入力してください" });
  });

  it("長すぎる語は断る（上限ちょうどは足せる）", () => {
    expect(addWord([], "あ".repeat(MAX_WORD_LENGTH)).ok).toBe(true);
    expect(addWord([], "あ".repeat(MAX_WORD_LENGTH + 1)).ok).toBe(false);
  });

  it("同じ語は、大文字小文字を区別せず断る", () => {
    expect(addWord(["Temp"], "temp")).toEqual({ ok: false, message: "同じ語がすでにあります" });
  });
});

describe("removeWord", () => {
  it("語を消す。選択中の語を消したら選択も外し、ほかの語を消しても選択は残る", () => {
    const state = { words: ["電圧", "電流"], selected: "電圧" };
    expect(removeWord(state, "電圧")).toEqual({ words: ["電流"], selected: null });
    expect(removeWord(state, "電流")).toEqual({ words: ["電圧"], selected: "電圧" });
  });
});

describe("保存と復元", () => {
  it("保存が無ければ既定（電圧・電流・電位、選択なし）", () => {
    expect(loadWordFilter()).toEqual({ words: [...DEFAULT_WORDS], selected: null });
  });

  it("保存した語と選択を、そのまま復元する", () => {
    saveWordFilter({ words: ["電圧", "温度"], selected: "温度" });
    expect(loadWordFilter()).toEqual({ words: ["電圧", "温度"], selected: "温度" });
  });

  it("語をすべて消した状態も、そのまま復元する（壊れた値ではない）", () => {
    saveWordFilter({ words: [], selected: null });
    expect(loadWordFilter()).toEqual({ words: [], selected: null });
  });

  it.each([
    ["JSON ではない", "{oops"],
    ["配列ではない語", JSON.stringify({ words: "電圧", selected: null })],
    ["文字列ではない語", JSON.stringify({ words: [1], selected: null })],
    ["空の語", JSON.stringify({ words: [""], selected: null })],
    ["長すぎる語", JSON.stringify({ words: ["あ".repeat(MAX_WORD_LENGTH + 1)], selected: null })],
    ["重複した語", JSON.stringify({ words: ["a", "A"], selected: null })],
    ["語にない選択", JSON.stringify({ words: ["電圧"], selected: "電流" })],
    ["オブジェクトではない", "123"],
  ])("壊れた値（%s）は既定に戻す", (_name, raw) => {
    window.localStorage.setItem(KEY, raw);
    expect(loadWordFilter()).toEqual(defaultWordFilter());
  });

  it("localStorage が使えない環境でも、読み書きで例外を出さず、既定で動く", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(loadWordFilter()).toEqual(defaultWordFilter());
    expect(() => saveWordFilter({ words: ["電圧"], selected: null })).not.toThrow();
  });
});
