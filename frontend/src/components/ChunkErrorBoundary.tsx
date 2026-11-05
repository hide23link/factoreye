/**
 * 遅延読み込みした部品の読み込みに失敗したとき（回線の不調や、デプロイで古いファイルが消えた後）に、
 * 再読み込みの案内を出す。自動の再読み込みは lib/lazyWithRetry.ts が 1 回だけ行うので、ここへ来るのは、それでも失敗した場合。
 * チャンクの読み込み失敗以外のエラー（描画のエラーなど）は案内に置き換えず、境界より上へ投げ直す
 * （上位の境界は無いので、従来どおりの挙動になる）。
 *
 * 【誰が使うか】App.tsx、main.tsx、WidgetCard.tsx が、遅延読み込みする部品を包む。
 * 【引数】children（中に入れる部品）だけ。呼ぶ側が <ChunkErrorBoundary>...</ChunkErrorBoundary> と書く。
 */
import { Component, type ReactNode } from "react";

import { isChunkLoadError } from "../lib/lazyWithRetry";
import { ErrorNotice } from "./ErrorNotice";

type Props = { children: ReactNode };
type State = { error: unknown };
const NO_ERROR = Symbol("no-error");

export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { error: NO_ERROR };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (this.state.error === NO_ERROR) return this.props.children;
    // チャンク以外のエラーは、読み込み失敗の案内にせず、上へ投げ直す
    if (!isChunkLoadError(this.state.error)) throw this.state.error;
    return (
      <ErrorNotice
        message="画面の読み込みに失敗しました。ページを再読み込みしてください。"
        onRetry={() => window.location.reload()}
      />
    );
  }
}
