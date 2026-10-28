/**
 * 管理者画面の「R2 から復旧する」。本番（Proxmox の LXC）が消えて作り直した直後（DB が空）や、
 * データが一部しか無いときに、R2 に残っている WAL-G のバックアップ（ベース ＋ WAL）から、
 * 本番に無い行だけを足す（今ある行は変えない・消さない。何度実行しても二重にならない）。
 * 流れ: ① 復元を始める（取得中 → 再生中 → 準備完了。数分かかる）と、バックアップの内容が出る
 * → ② 試算（追加される件数。何も書かない）→ ③ 確認の小窓 → ④ 実行 → ⑤ 結果。
 * 「引き継ぎ（控えの増加分）も合わせる」を選ぶと、R2 → 引き継ぎの順に、1 回の操作で合流する。
 * 実際の処理は、バックエンドが復旧ツール（tools/recovery）に頼む。
 *
 * 【誰が使うか】AdminUsersPage.tsx が、「書き戻し」の下に置く。
 * 【引数（props）】token=管理者トークン、onAuthError=トークンが失効（401）したときの処理。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  AdminApiError,
  adminErrorDetail,
  applyR2Failback,
  fetchFailbackHandoffs,
  fetchR2Status,
  previewR2Failback,
  resetR2Restore,
  startR2Restore,
} from "../../lib/adminApi";
import type { FailbackResult, R2Status } from "../../lib/adminApi";
import { ConfirmDialog } from "../ConfirmDialog";
import { FailbackResultTable } from "./FailbackResultTable";
import { LIMITATION, TIMEOUT_HINT, formatDateTime } from "./failbackShared";

interface Props {
  token: string;
  onAuthError: () => void;
}

const STATUS_KEY = ["admin", "failback", "r2"] as const;

const STATE_LABELS: Record<R2Status["state"], string> = {
  idle: "未開始",
  fetching: "取得中（R2 の最新のベースを取っています）",
  replaying: "再生中（WAL を最新まで再生しています）",
  ready: "準備完了",
  failed: "失敗",
};

const isAuthError = (e: unknown) =>
  e instanceof AdminApiError && (e.status === 401 || e.status === 403);

// R2 のバックアップから、本番に無い行だけを足す（復元 → 試算 → 確認 → 実行 → 結果）
export function R2RestoreCard({ token, onAuthError }: Props) {
  const queryClient = useQueryClient();
  const [withHandoff, setWithHandoff] = useState(false);
  const [preview, setPreview] = useState<FailbackResult | null>(null);
  const [applied, setApplied] = useState<FailbackResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => fetchR2Status(token),
    retry: false,
    // 復元の最中だけ、数秒ごとに状態を読み直す
    refetchInterval: (query) =>
      query.state.data?.state === "fetching" || query.state.data?.state === "replaying"
        ? 3000
        : false,
  });
  // 合わせて合流する引き継ぎは、一覧の先頭（最新）。一覧が取れなければ、選択肢を出さない
  const handoffs = useQuery({
    queryKey: ["admin", "failback", "handoffs"],
    queryFn: () => fetchFailbackHandoffs(token),
    retry: false,
  });
  const latestHandoff = handoffs.data?.items[0]?.name ?? null;
  const handoff = withHandoff ? latestHandoff : null;

  const startMutation = useMutation({
    mutationFn: () => startR2Restore(token),
    onSuccess: (data) => {
      setPreview(null);
      setApplied(null);
      queryClient.setQueryData(STATUS_KEY, data);
    },
  });
  const resetMutation = useMutation({
    mutationFn: () => resetR2Restore(token),
    onSuccess: (data) => {
      setPreview(null);
      setApplied(null);
      queryClient.setQueryData(STATUS_KEY, data);
    },
  });
  const previewMutation = useMutation({
    mutationFn: () => previewR2Failback(token, handoff),
    onSuccess: setPreview,
  });
  const applyMutation = useMutation({
    mutationFn: (expected: number) => applyR2Failback(token, handoff, expected),
    onSuccess: (data) => {
      setApplied(data);
      setPreview(null);
      setConfirming(false);
    },
    onError: () => {
      // 失敗したら小窓は閉じ、試算をやり直してもらう（件数が変わった・版の違いなど）
      setConfirming(false);
      setPreview(null);
    },
  });

  const authFailed = [
    status.error,
    startMutation.error,
    resetMutation.error,
    previewMutation.error,
    applyMutation.error,
  ].some(isAuthError);
  useEffect(() => {
    if (authFailed) onAuthError();
  }, [authFailed, onAuthError]);

  const data = status.data;
  const state = data?.state ?? "idle";
  const running = state === "fetching" || state === "replaying";
  const busy =
    running ||
    startMutation.isPending ||
    resetMutation.isPending ||
    previewMutation.isPending ||
    applyMutation.isPending;

  const actionError =
    applyMutation.error ?? previewMutation.error ?? startMutation.error ?? resetMutation.error;
  const errorText = (() => {
    if (!actionError || isAuthError(actionError)) return null;
    const text = adminErrorDetail(actionError, "操作に失敗しました。もう一度お試しください");
    return actionError instanceof AdminApiError && actionError.status === 504
      ? `${text} ${TIMEOUT_HINT}`
      : text;
  })();

  const info = data?.info;

  return (
    <section className="mb-6 rounded border border-gray-200 bg-white p-4" data-testid="r2-card">
      <h2 className="mb-1 text-sm font-bold text-gray-900">R2 から復旧する</h2>
      <p className="mb-3 text-sm text-gray-600">
        本番が消えて作り直した直後（DB が空）や、データが一部しか無いときに、R2 に残っている
        バックアップ（ベース ＋ WAL）から、本番に無い行だけを足します。今ある行は変えません・消しません。
        何度実行しても二重になりません。{LIMITATION}
        復元は数分かかります。書き戻す前に、取り込み（機器からの送信）を止めるか減らしてください。
        作業用の復元は、使い終わったら消します（本番の DB と同じ大きさの空きが要ります）。
      </p>

      {status.isError && !authFailed && (
        <p className="text-sm text-red-600" role="alert">
          {adminErrorDetail(status.error, "状態を取得できませんでした")}
        </p>
      )}
      {data && !data.configured && (
        <p className="text-sm text-gray-500">
          {data.message ?? "R2 からの復旧は設定されていません（復旧ツールの walg.env）"}
        </p>
      )}

      {data?.configured && (
        <>
          <p className="text-sm text-gray-900" data-testid="r2-state">
            状態: <span className="font-bold">{STATE_LABELS[state]}</span>
          </p>
          {state === "failed" && data.message && (
            <p className="mt-1 text-sm text-red-600" role="alert">
              {data.message}
            </p>
          )}
          {info && (info.baseName || info.alembic) && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-gray-700" data-testid="r2-info">
              <dt className="text-gray-500">最新のベース</dt>
              <dd>
                {info.baseName ?? "—"}（{formatDateTime(info.baseTime)}）
              </dd>
              <dt className="text-gray-500">WAL の最終時刻</dt>
              <dd>{formatDateTime(info.walLastTime)}</dd>
              <dt className="text-gray-500">最新の測定値</dt>
              <dd>{formatDateTime(info.latestReading)}</dd>
              <dt className="text-gray-500">スキーマの版</dt>
              <dd className="font-mono">{info.alembic ?? "—"}</dd>
            </dl>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {state !== "ready" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => startMutation.mutate()}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800 disabled:opacity-50"
              >
                {state === "failed" ? "もう一度、R2 から復元する" : "R2 の最新から復元する"}
              </button>
            )}
            {state === "ready" && (
              <>
                {latestHandoff && (
                  <label className="flex items-center gap-1 text-sm text-gray-800">
                    <input
                      type="checkbox"
                      checked={withHandoff}
                      disabled={busy}
                      onChange={(e) => {
                        setWithHandoff(e.target.checked);
                        setPreview(null);
                      }}
                    />
                    引き継ぎ（控えの増加分）も合わせる
                  </label>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => previewMutation.mutate()}
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800 disabled:opacity-50"
                >
                  試算する
                </button>
              </>
            )}
            {(state === "ready" || state === "failed") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => resetMutation.mutate()}
                className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50"
              >
                作業用の復元を消す
              </button>
            )}
          </div>
        </>
      )}

      {previewMutation.isPending && <p className="mt-3 text-sm text-gray-500">試算中…</p>}
      {errorText && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {errorText}
        </p>
      )}

      {preview && (
        <div className="mt-3" data-testid="r2-preview">
          <p className="text-sm text-gray-900">
            試算の結果: 本番に{" "}
            <span className="font-bold">{preview.totalInserted.toLocaleString()}</span>{" "}
            行が足されます（まだ書き込んでいません）
            {preview.parts.length > 1 && "（R2 → 引き継ぎの順に合わせた合計）"}
          </p>
          <FailbackResultTable result={preview} />
          <div className="mt-3">
            <button
              type="button"
              disabled={busy || preview.totalInserted === 0}
              onClick={() => setConfirming(true)}
              className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
            >
              本番に書き戻す
            </button>
            {preview.totalInserted === 0 && (
              <span className="ml-2 text-sm text-gray-500">足す行はありません</span>
            )}
          </div>
        </div>
      )}

      {applied && (
        <div className="mt-3 rounded bg-green-50 p-3" data-testid="r2-applied" role="status">
          <p className="text-sm font-bold text-green-800">
            書き戻しました（{applied.totalInserted.toLocaleString()} 行を足しました）
          </p>
          {applied.snapshot && (
            <p className="mt-1 text-xs text-gray-700">
              直前の本番の控え: <span className="font-mono">{applied.snapshot}</span>
            </p>
          )}
          <FailbackResultTable result={applied} />
        </div>
      )}

      {confirming && preview && (
        <ConfirmDialog
          title="R2 から本番に書き戻しますか？"
          message={
            `${preview.totalInserted.toLocaleString()} 行を本番に足します。` +
            "実行の直前に本番の控えを取り、1 つのトランザクションで書きます" +
            "（途中で失敗したら何も書きません）。" +
            LIMITATION
          }
          confirmLabel="書き戻す"
          pending={applyMutation.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => applyMutation.mutate(preview.totalInserted)}
        />
      )}
    </section>
  );
}
