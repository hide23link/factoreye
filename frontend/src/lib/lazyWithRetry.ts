/**
 * 画面の部品を、必要になった時に読み込む（React.lazy）ための部品。
 *
 * デプロイのたびにチャンク（分割したファイル）の名前のハッシュが変わる。古い index.html を持つブラウザが、
 * 消えた古いチャンクを要求すると、動的 import が失敗する。その場合は 1 回だけ自動で再読み込みし、
 * 新しい index.html を取り直す。再読み込みしても失敗するなら、エラーを投げて ChunkErrorBoundary に表示させる
 * （再読み込みの繰り返しにはならない）。
 *
 * 【誰が使うか】main.tsx、App.tsx、WidgetCard.tsx が、`lazyNamed(() => import(...), "名前")` と書く。
 */
import { lazy, type ComponentType } from "react";

/** 自動で再読み込みしたことを覚えるキー（sessionStorage。タブごと） */
export const RELOAD_FLAG_KEY = "factoreye:chunk-reload";

/** 動的 import の失敗（チャンクの取得失敗）か。ブラウザごとにメッセージが違う。 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "ChunkLoadError" ||
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk .* failed|Loading CSS chunk/i.test(
      error.message,
    )
  );
}

function readFlag(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_FLAG_KEY) !== null;
  } catch {
    return true; // 印を扱えない環境では、再読み込みの繰り返しを避けるため、自動の再読み込みはしない
  }
}

function writeFlag(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(RELOAD_FLAG_KEY, String(Date.now()));
    else sessionStorage.removeItem(RELOAD_FLAG_KEY);
  } catch {
    // 無視する
  }
}

/**
 * 動的 import を包む。チャンクの取得に失敗したら、1 回だけページを再読み込みする。
 * 読み込みに成功したら印を消す（次のデプロイでも、もう 1 回だけ試せる）。
 */
export function importWithRetry<T>(factory: () => Promise<T>): Promise<T> {
  return factory().then(
    (module) => {
      writeFlag(false);
      return module;
    },
    (error: unknown) => {
      if (isChunkLoadError(error) && !readFlag()) {
        writeFlag(true);
        window.location.reload();
        // 再読み込みが始まるまで、画面は「読み込み中」のまま待つ（エラー表示を一瞬出さない）
        return new Promise<T>(() => {});
      }
      throw error;
    },
  );
}

/** 名前付きエクスポートの部品を、React.lazy で読み込めるようにする。 */
export function lazyNamed<K extends string, P extends object>(
  factory: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
) {
  return lazy(() => importWithRetry(factory).then((m) => ({ default: m[name] })));
}
