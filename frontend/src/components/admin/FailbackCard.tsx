/**
 * 管理者画面の「書き戻し」。本番が止まっている間に控え（AWS）が稼いだデータのうち、
 * 本番に無い行だけを足す（今ある行は変えない・消さない。何度実行しても二重にならない）。
 * 流れ: ① 引き継ぎの一覧 → ② 試算（追加される件数。何も書かない）→ ③ 確認の小窓 → ④ 実行 → ⑤ 結果。
 * 実際の書き込みは、バックエンドが復旧ツール（tools/recovery）に頼む。実行の直前には本番の控えを取り、
 * 1 つのトランザクションで書く。試算の件数と実行の直前の件数が違えば、実行されない。
 *
 * 【誰が使うか】AdminUsersPage.tsx が、画面の上部に置く。
 * 【引数（props）】token=管理者トークン、onAuthError=トークンが失効（401）したときの処理。
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  AdminApiError,
  adminErrorDetail,
  applyFailback,
  fetchFailbackHandoffs,
  previewFailback,
} from "../../lib/adminApi";
import type { FailbackHandoff, FailbackResult } from "../../lib/adminApi";
import { ConfirmDialog } from "../ConfirmDialog";

interface Props {
  token: string;
  onAuthError: () => void;
}

const isAuthError = (e: unknown) =>
  e instanceof AdminApiError && (e.status === 401 || e.status === 403);

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

// 表の名前を、画面の言葉にする（知らない表は、そのまま出す）
const TABLE_LABELS: Record<string, string> = {
  users: "利用者",
  workspaces: "ワークスペース",
  sensors: "センサー",
  readings: "測定値",
  alarms: "アラーム",
  dashboards: "ダッシュボード",
  widgets: "ウィジェット",
  webhook_subscriptions: "Webhook",
  notification_settings: "通知設定",
};

// 書き戻しの前に、管理者に必ず伝えること
const LIMITATION =
  "控えの稼働中に行われた、既存の行の更新・削除（パスワードの変更など）は戻りません。" +
  "また、本番に復帰したあとに削除したセンサー・ダッシュボード・ウィジェット・Webhook・利用者は、" +
  "引き継ぎに残っていれば復活します。";

// 時間切れ（504）のときに足す案内。書き込みは復旧ツールの中で続いているかもしれない
const TIMEOUT_HINT = "再度試算して、追加が 0 件なら、書き戻しは完了しています。";

// 書き戻しの表（試算と結果で共通）
function ResultTable({ result }: { result: FailbackResult }) {
  return (
    <table className="mt-2 w-full text-left text-sm" data-testid="failback-tables">
      <thead>
        <tr className="text-xs text-gray-500">
          <th className="py-1 pr-2 font-normal">データ</th>
          <th className="py-1 pr-2 text-right font-normal">引き継ぎの行数</th>
          <th className="py-1 pr-2 text-right font-normal">
            {result.applied ? "足した行数" : "足される行数"}
          </th>
          <th className="py-1 text-right font-normal">本番に既にある</th>
        </tr>
      </thead>
      <tbody>
        {result.tables.map((t) => (
          <tr key={t.table} className="border-t border-gray-100">
            <td className="py-1 pr-2">
              {TABLE_LABELS[t.table] ?? t.table}
              {t.note && <span className="ml-2 text-xs text-amber-700">{t.note}</span>}
            </td>
            <td className="py-1 pr-2 text-right">{t.source.toLocaleString()}</td>
            <td className="py-1 pr-2 text-right font-bold">{t.inserted.toLocaleString()}</td>
            <td className="py-1 text-right text-gray-500">{t.existing.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 控えが稼いだデータを、本番に無い行だけ足す（一覧 → 試算 → 確認 → 実行 → 結果）
export function FailbackCard({ token, onAuthError }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<FailbackResult | null>(null);
  const [applied, setApplied] = useState<FailbackResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const handoffs = useQuery({
    queryKey: ["admin", "failback", "handoffs"],
    queryFn: () => fetchFailbackHandoffs(token),
    // 復旧ツールに接続できないときに、何度も呼び直さない（エラーの文をすぐ見せる）
    retry: false,
  });

  const previewMutation = useMutation({
    mutationFn: (name: string) => previewFailback(token, name),
    onSuccess: setPreview,
  });
  const applyMutation = useMutation({
    mutationFn: ({ name, expected }: { name: string; expected: number }) =>
      applyFailback(token, name, expected),
    onSuccess: (data) => {
      setApplied(data);
      setPreview(null);
      setConfirming(false);
    },
    onError: () => {
      // 失敗したら、確認の小窓は閉じる。件数が変わった（409）ときは、試算をやり直してもらう
      setConfirming(false);
      setPreview(null);
    },
  });

  // 期限切れ・権限剥奪（401/403）は再ログインへ戻す
  const authFailed = [handoffs.error, previewMutation.error, applyMutation.error].some(isAuthError);
  useEffect(() => {
    if (authFailed) onAuthError();
  }, [authFailed, onAuthError]);

  const select = (name: string) => {
    setSelected(name);
    setPreview(null);
    setApplied(null);
    previewMutation.reset();
    applyMutation.reset();
  };

  const items: FailbackHandoff[] = handoffs.data?.items ?? [];
  const busy = previewMutation.isPending || applyMutation.isPending;
  const errorText = (() => {
    const error = applyMutation.error ?? previewMutation.error;
    if (!error) return null;
    const fallback = applyMutation.error
      ? "書き戻しに失敗しました。もう一度お試しください"
      : "試算に失敗しました。もう一度お試しください";
    const text = adminErrorDetail(error, fallback);
    return error instanceof AdminApiError && error.status === 504 ? `${text} ${TIMEOUT_HINT}` : text;
  })();

  return (
    <section className="mb-6 rounded border border-gray-200 bg-white p-4" data-testid="failback-card">
      <h2 className="mb-1 text-sm font-bold text-gray-900">書き戻し（控えが稼いだデータ）</h2>
      <p className="mb-3 text-sm text-gray-600">
        本番が止まっている間に控え（AWS）が受け取ったデータのうち、本番に無い行だけを足します。
        今ある行は変えません・消しません。何度実行しても二重になりません。{LIMITATION}
      </p>
      <p className="mb-3 text-sm text-gray-600">
        書き戻す前に、取り込み（機器からの送信）を止めるか減らしてください。書き戻しの間、測定値の
        挿入は待たされます（重複はできません）。書き戻した行だけを消す手順はありません。
        実行前に、試算の件数を確かめてください。
      </p>

      {handoffs.isPending && <p className="text-sm text-gray-500">引き継ぎを読み込み中…</p>}
      {handoffs.isError && !authFailed && (
        <p className="text-sm text-red-600" role="alert">
          {adminErrorDetail(handoffs.error, "引き継ぎの一覧を取得できませんでした")}
        </p>
      )}
      {handoffs.data && items.length === 0 && (
        <p className="text-sm text-gray-500">
          引き継ぎはありません（控えがまだ動いていないか、増加分が置かれていません）
        </p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded border border-gray-200 text-sm">
          {items.map((item) => (
            <li key={item.name} className="flex items-center justify-between gap-2 p-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-gray-900">{item.name}</div>
                <div className="text-xs text-gray-500">
                  {formatDateTime(item.modified)}・{formatBytes(item.size)}
                  ・種類: {item.kind ?? "不明（古い記録）"}
                  {item.watermark && <>・起点: {item.watermark}</>}
                  {item.region && <>・{item.region}</>}
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  select(item.name);
                  previewMutation.mutate(item.name);
                }}
                className="shrink-0 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800 disabled:opacity-50"
                aria-label={`${item.name} を試算する`}
              >
                試算する
              </button>
            </li>
          ))}
        </ul>
      )}

      {previewMutation.isPending && <p className="mt-3 text-sm text-gray-500">試算中…</p>}
      {errorText && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {errorText}
        </p>
      )}

      {preview && selected && (
        <div className="mt-3" data-testid="failback-preview">
          <p className="text-sm text-gray-900">
            試算の結果: 本番に <span className="font-bold">{preview.totalInserted.toLocaleString()}</span>{" "}
            行が足されます（まだ書き込んでいません）
          </p>
          <ResultTable result={preview} />
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
        <div className="mt-3 rounded bg-green-50 p-3" data-testid="failback-applied" role="status">
          <p className="text-sm font-bold text-green-800">
            書き戻しました（{applied.totalInserted.toLocaleString()} 行を足しました）
          </p>
          {applied.snapshot && (
            <p className="mt-1 text-xs text-gray-700">
              直前の本番の控え: <span className="font-mono">{applied.snapshot}</span>
              （復旧ツールの一覧に出ます。取り消したいときは、ここから戻します）
            </p>
          )}
          <ResultTable result={applied} />
        </div>
      )}

      {confirming && preview && selected && (
        <ConfirmDialog
          title="本番に書き戻しますか？"
          message={
            `${preview.totalInserted.toLocaleString()} 行を本番に足します。` +
            "実行の直前に本番の控えを取り、1 つのトランザクションで書きます" +
            "（途中で失敗したら何も書きません）。" +
            LIMITATION
          }
          confirmLabel="書き戻す"
          pending={applyMutation.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            applyMutation.mutate({ name: selected, expected: preview.totalInserted })
          }
        />
      )}
    </section>
  );
}
