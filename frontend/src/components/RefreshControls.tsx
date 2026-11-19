/**
 * 画面全体の更新間隔の選択、手動更新ボタン（⟳）、最終更新時刻を出す部品。
 *
 * - 選択: 各グラフの設定（既定）/ Off / 10 秒 / 30 秒 / 1 分 / 5 分（10 秒は OSS だけ）
 * - ⟳: 全部の取得を取り直す（queryClient.invalidateQueries）。Off のときに使う
 * - 最終更新: グラフ用の取得で、最後にデータが届いた時刻（例: 更新 07:51:41）。Off のときは橙で「手動」を添える
 *
 * 【誰が使うか】TimeRangeControls が、時間の操作の並びに置く（狭い画面では「操作」の中）。
 * 【引数（props）】なし。選択は useRefreshStore に直接読み書きする。
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { availableRefreshChoices, formatUpdatedAt, latestUpdatedAt, type RefreshChoice } from "../lib/refresh-interval";
import { useRefreshStore } from "../store/useRefreshStore";

const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

// 最終更新の対象にする取得（グラフ用の間引きデータ）
const GRAPH_QUERY_KEY = ["readings-downsampled"];

export function RefreshControls() {
  const queryClient = useQueryClient();
  const choice = useRefreshStore((s) => s.choice);
  const setChoice = useRefreshStore((s) => s.setChoice);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // 取得のキャッシュが変わるたびに、最終更新時刻を求め直す
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const refresh = () => setUpdatedAt(latestUpdatedAt(cache.findAll({ queryKey: GRAPH_QUERY_KEY }).map((q) => q.state)));
    refresh();
    return cache.subscribe(refresh);
  }, [queryClient]);

  return (
    <span className="inline-flex items-center gap-2" data-testid="refresh-controls">
      <select
        aria-label="更新間隔"
        value={choice}
        onChange={(event) => setChoice(event.target.value as RefreshChoice)}
        className="rounded border border-gray-300 px-2 py-1"
      >
        {availableRefreshChoices(IS_MULTI_TENANT).map((c) => (
          <option key={c.value} value={c.value}>
            更新: {c.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="今すぐ更新"
        onClick={() => void queryClient.invalidateQueries()}
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
