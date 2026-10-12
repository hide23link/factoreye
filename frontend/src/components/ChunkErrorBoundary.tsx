/**
 * 遅延読み込みした部品の読み込みに失敗したとき（回線の不調や、デプロイで古いファイルが消えた後）に、
 * 再読み込みの案内を出す。自動の再読み込みは lib/lazyWithRetry.ts が 1 回だけ行うので、ここへ来るのは、それでも失敗した場合。
 */
import { Component, type ReactNode } from "react";

import { ErrorNotice } from "./ErrorNotice";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <ErrorNotice
        message="画面の読み込みに失敗しました。ページを再読み込みしてください。"
        onRetry={() => window.location.reload()}
      />
    );
  }
}
