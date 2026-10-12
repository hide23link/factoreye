import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChunkErrorBoundary } from "../components/ChunkErrorBoundary";
import { importWithRetry, isChunkLoadError, lazyNamed, RELOAD_FLAG_KEY } from "./lazyWithRetry";

const reload = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  sessionStorage.clear();
  reload.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

const chunkError = () => new TypeError("Failed to fetch dynamically imported module: /assets/X-abc.js");

describe("isChunkLoadError", () => {
  it("動的 import の失敗を、ブラウザごとのメッセージで判定する", () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    const named = new Error("x");
    named.name = "ChunkLoadError";
    expect(isChunkLoadError(named)).toBe(true);
  });

  it("関係のないエラーは判定しない", () => {
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
  });
});

describe("importWithRetry", () => {
  it("成功したら値を返し、再読み込みの印を消す", async () => {
    sessionStorage.setItem(RELOAD_FLAG_KEY, "1");
    await expect(importWithRetry(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(sessionStorage.getItem(RELOAD_FLAG_KEY)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("チャンクの取得に失敗したら、1 回だけ再読み込みする（結果は待ち続ける）", async () => {
    const settled = vi.fn();
    void importWithRetry(() => Promise.reject(chunkError())).then(settled, settled);
    await new Promise((r) => setTimeout(r, 10));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOAD_FLAG_KEY)).not.toBeNull();
    expect(settled).not.toHaveBeenCalled();
  });

  it("再読み込み後にも失敗したら、再読み込みせずエラーを投げる", async () => {
    sessionStorage.setItem(RELOAD_FLAG_KEY, "1");
    await expect(importWithRetry(() => Promise.reject(chunkError()))).rejects.toThrow(/dynamically imported/);
    expect(reload).not.toHaveBeenCalled();
  });

  it("チャンク以外のエラーは、再読み込みせずに投げる", async () => {
    await expect(importWithRetry(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_FLAG_KEY)).toBeNull();
  });
});

describe("lazyNamed と ChunkErrorBoundary", () => {
  function Hello() {
    return <p>こんにちは</p>;
  }

  it("名前付きエクスポートを読み込んで表示する（読み込み中の表示を経る）", async () => {
    const Lazy = lazyNamed(() => Promise.resolve({ Hello }), "Hello");
    render(
      <ChunkErrorBoundary>
        <Suspense fallback={<p>読み込み中...</p>}>
          <Lazy />
        </Suspense>
      </ChunkErrorBoundary>,
    );
    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
    expect(await screen.findByText("こんにちは")).toBeInTheDocument();
  });

  it("1 回目の失敗は再読み込み、2 回目の失敗は再読み込みの案内を表示する", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const load = () => Promise.reject(chunkError());

    // 1 回目: 再読み込みを呼び、エラー表示は出さない（読み込み中のまま）
    const First = lazyNamed(load as () => Promise<{ Hello: typeof Hello }>, "Hello");
    const first = render(
      <ChunkErrorBoundary>
        <Suspense fallback={<p>読み込み中...</p>}>
          <First />
        </Suspense>
      </ChunkErrorBoundary>,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("読み込み中...")).toBeInTheDocument();
    first.unmount();

    // 再読み込み後（印が残っている）にも失敗: 案内を表示し、自動では再読み込みしない
    const Second = lazyNamed(load as () => Promise<{ Hello: typeof Hello }>, "Hello");
    render(
      <ChunkErrorBoundary>
        <Suspense fallback={<p>読み込み中...</p>}>
          <Second />
        </Suspense>
      </ChunkErrorBoundary>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("ページを再読み込みしてください");
    expect(reload).toHaveBeenCalledTimes(1);

    // 「再試行」ボタンは、利用者の操作で再読み込みする
    await user.click(screen.getByRole("button", { name: "再試行" }));
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
