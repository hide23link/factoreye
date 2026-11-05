/**
 * 管理者画面の「取り込みのレート制限」の表示と、期限付きの解除の操作。
 * 解除の状態は、バックエンド（app/ingest_limit_toggle.py）のメモリにあり、30秒ごとに取り直す。
 *
 * 【誰が使うか】AdminUsersPage.tsx が、画面の上部に置く。
 * 【引数（props）】token=管理者トークン、onAuthError=トークンが失効（401）したときの処理。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { AdminApiError, fetchIngestLimit, setIngestLimit } from "../../lib/adminApi";
import type { IngestLimitStatus } from "../../lib/adminApi";

interface Props {
  token: string;
  onAuthError: () => void;
}

const QUERY_KEY = ["admin", "ingest-limit"] as const;

// 解除の時間の選択肢（分）。上限は 240 分（バックエンドの MAX_BYPASS_MINUTES と一致させる）
const UNLOCK_CHOICES = [60, 240] as const;

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ja-JP");
}

function describe(status: IngestLimitStatus): string {
  if (status.envOff) {
    return "環境変数（INGEST_RATE_LIMIT=off）で解除されています。この画面からは変更できません";
  }
  if (status.bypassed) {
    return `制限を解除中（${formatDateTime(status.bypassUntil)} まで・解除した管理者: ${status.setBy ?? "—"}）`;
  }
  return `制限あり（既定: ${status.defaultLimit}）`;
}

// 取り込みのレート制限を、管理者が期限付きで解除する・戻す
export function IngestLimitCard({ token, onAuthError }: Props) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchIngestLimit(token),
    // 期限切れで自動的に戻るため、表示は定期的に読み直す
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: ({ enabled, minutes }: { enabled: boolean; minutes?: number }) =>
      setIngestLimit(token, enabled, minutes),
    onSuccess: (data) => queryClient.setQueryData(QUERY_KEY, data),
    onError: (error) => {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        onAuthError();
      }
    },
  });

  // 期限切れ・権限剥奪（401/403）は再ログインへ戻す
  const authFailed =
    query.error instanceof AdminApiError && (query.error.status === 401 || query.error.status === 403);
  useEffect(() => {
    if (authFailed) onAuthError();
  }, [authFailed, onAuthError]);

  const status = query.data;
  const locked = status?.envOff ?? true;
  const busy = mutation.isPending;

  return (
    <section className="mb-6 rounded border border-gray-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-bold text-gray-900">取り込みのレート制限</h2>
      {query.isPending && <p className="text-sm text-gray-500">読み込み中…</p>}
      {status && (
        <>
          <p
            className={`text-sm ${status.bypassed ? "font-bold text-red-700" : "text-gray-800"}`}
            data-testid="ingest-limit-state"
          >
            {describe(status)}
          </p>
          <div className="mt-3 flex gap-2">
            {status.bypassed ? (
              <button
                type="button"
                disabled={locked || busy}
                onClick={() => mutation.mutate({ enabled: false })}
                className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                今すぐ制限を戻す
              </button>
            ) : (
              <>
                {UNLOCK_CHOICES.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    disabled={locked || busy}
                    onClick={() => {
                      // 解除は本番の取り込みを止めないための制限を外す操作なので、確認を挟む
                      if (window.confirm(`取り込みの制限を ${minutes} 分だけ解除します。よろしいですか？`)) {
                        mutation.mutate({ enabled: true, minutes });
                      }
                    }}
                    className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 disabled:opacity-50"
                  >
                    {minutes} 分だけ解除
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
      {(query.isError || mutation.isError) && (
        <p className="mt-2 text-sm text-red-600">操作に失敗しました。もう一度お試しください</p>
      )}
    </section>
  );
}
