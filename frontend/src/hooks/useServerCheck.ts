import { useQuery } from "@tanstack/react-query";

import { fetchHealth } from "../lib/api";

/** 確かめる間隔（ミリ秒）。セットアップガイドの「3 秒ごとに確かめています」と合わせる */
export const SERVER_CHECK_INTERVAL_MS = 3000;

/** サーバーとの接続の確かめ結果 */
export interface ServerCheck {
  /** 確かめ中（最初の 1 回がまだ）は "checking"、つながれば "ok"、つながらなければ "down" */
  status: "checking" | "ok" | "down";
  /** 直近の応答にかかった時間（ミリ秒）。つながっているときだけ */
  responseMs: number | null;
}

/**
 * サーバーに /health を送って、つながるかと応答の速さを一定間隔で確かめる。
 * 例: 応答が 38 ミリ秒なら { status: "ok", responseMs: 38 }
 *
 * 【誰が使うか】セットアップガイドの「テストデータを送る」の、受信待ちの表（サーバーの行）。
 */
export function useServerCheck(enabled: boolean): ServerCheck {
  const { data, isError, isPending } = useQuery({
    queryKey: ["setup-server-check"],
    queryFn: async () => {
      const startedAt = performance.now();
      await fetchHealth();
      return Math.max(1, Math.round(performance.now() - startedAt));
    },
    enabled,
    retry: false,
    refetchInterval: SERVER_CHECK_INTERVAL_MS,
  });
  if (data !== undefined && !isError) return { status: "ok", responseMs: data };
  if (isError) return { status: "down", responseMs: null };
  return { status: isPending ? "checking" : "down", responseMs: null };
}
