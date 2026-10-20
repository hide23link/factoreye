/**
 * 編集操作の保存が、いくつ進行中か（待ちを含む）を数える。
 *
 * 保存の途中でダッシュボードを取り直すと、画面が一瞬「保存前」の状態に戻ってちらつく。
 * そのため、進行中は 5 秒ごとの取り直しを止め、全部終わってから 1 回だけ取り直す。
 *
 * 【誰が使うか】useWidgetActions（数える）、queries.ts の useDashboard（取り直しを止める）。
 */
let pending = 0;

export const pendingSaves = {
  start: () => {
    pending += 1;
  },
  /** 1 つ終わらせ、全部終わったら true を返す */
  finish: (): boolean => {
    pending = Math.max(0, pending - 1);
    return pending === 0;
  },
  isBusy: () => pending > 0,
};
