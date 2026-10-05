/**
 * データ取得（React Query）の共通設定。
 *
 * - staleTime 2 秒: 取得したデータを2秒は新しいものとして扱い、同じ要求を連続で送らない
 * - retry 1: 失敗したら1回だけ再試行する（通信の一時的な失敗を吸収する）
 */
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      retry: 1,
    },
  },
});
