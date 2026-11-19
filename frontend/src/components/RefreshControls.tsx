/**
 * 画面全体の更新間隔の選択、手動更新ボタン（⟳）、最終更新時刻を出す部品。
 *
 * - 選択: 各グラフの設定（既定）/ Off / 10 秒 / 30 秒 / 1 分 / 5 分（10 秒は OSS だけ）
 * - ⟳: ウィジェットの測定値の取得だけを取り直し、画面の現在時刻を進める。Off のときに使う
 * - 更新の対象はウィジェット（グラフ・数値・ゲージなど）だけ。センサー一覧・警報・全体監視は今までの間隔
 * - 最終更新: グラフ用の取得で、最後にデータが届いた時刻（例: 更新 07:51:41）。Off のときは橙で「手動」を添える
 *
 * 【誰が使うか】TimeRangeControls が、時間の操作の並びに置く（狭い画面では「操作」の中）。
 * 【引数（props）】なし。選択は useRefreshStore に直接読み書きする。
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { availableRefreshChoices, formatUpdatedAt, isWidgetQueryKey, latestUpdatedAt, type RefreshChoice } from "../lib/refresh-interval";
import { useRefreshStore } from "../store/useRefreshStore";

const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

export function RefreshControls() {
  const queryClient = useQueryClient();
  const choice = useRefreshStore((s) => s.choice);
  const setChoice = useRefreshStore((s) => s.setChoice);
  const markManualRefresh = useRefreshStore((s) => s.markManualRefresh);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // 取得のキャッシュが変わるたびに、最終更新時刻を求め直す
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    // 実際に取得が成功した時刻（dataUpdatedAt）の最新。表示と実データを食い違わせない
    const refresh = () => setUpdatedAt(latestUpdatedAt(cache.findAll({ predicate: (q) => isWidgetQueryKey(q.queryKey) }).map((q) => q.state)));
    refresh();
    return cache.subscribe(refresh);
  }, [queryClient]);

  return (
    <span className="inline-flex items-center gap-2" data-testid="refresh-controls">
      <select
        aria-label="更新間隔"
        title="更新の対象は、ウィジェット（グラフ・数値・ゲージなど）の測定値です。センサー一覧・警報・全体監視は、今までの間隔のままです"
        value={choice}
        onChange={(event) => setChoice(event.target.value as RefreshChoice)}
        className="rounded border border-gray-300 px-2 py-1"
      >
        {availableRefreshChoices(IS_MULTI_TENANT).map((c) => (
          <option key={c.value} value={c.value}>
            ウィジェット更新: {c.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="ウィジェットを今すぐ更新"
        title="ウィジェット（グラフなど）を今すぐ取り直す"
        onClick={() => {
          // 現在時刻を進め（直近のグラフは新しい範囲を取る）、ウィジェットの測定値の取得だけを取り直す
          markManualRefresh();
          void queryClient.invalidateQueries({ predicate: (q) => isWidgetQueryKey(q.queryKey) });
        }}
        className="min-h-10 rounded border border-gray-300 px-3 py-2 hover:bg-gray-100 sm:min-h-0 sm:px-2 sm:py-1"
      >
        ⟳
      </button>
      <span className="text-xs text-gray-500" data-testid="refresh-status">
        {updatedAt !== null && <>更新 {formatUpdatedAt(updatedAt)}</>}
        {choice === "off" && <span className="ml-1 font-bold text-orange-600">手動</span>}
      </span>
    </span>
  );
}
