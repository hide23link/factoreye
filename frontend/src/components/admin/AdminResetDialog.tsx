/**
 * 管理者の「リセット」の確認の小窓。端末を失くした・乗っ取りが心配な利用者のために、
 * 全端末のログイン（永久ログインを含む）を終了し、利用者のアドレスへ再登録のリンク（1 時間・1 回だけ）を送る。
 * 「登録済みのパスキーも削除する」は、既定でオン（端末を失くしたときのため）。実行は記録される。
 * 管理者が、利用者のパスキーやデータの中身を見ることはない。
 *
 * 【誰が使うか】AdminUsersPage.tsx（利用者の一覧の「リセット」ボタン）。
 * 【引数（props）】token=管理者トークン、email・userId=対象の利用者、onClose=閉じる、
 * onDone=実行できたとき（一覧を取り直す）、onAuthError=管理者トークンが失効したとき。
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { AdminApiError, resetAdminUser } from "../../lib/adminApi";

interface Props {
  token: string;
  userId: string;
  email: string;
  onClose: () => void;
  onDone: () => void;
  onAuthError: () => void;
}

/** 失敗の理由を、管理者向けの文にする（どれも「何も変更していません」）。 */
function describeResetError(err: unknown): string {
  if (err instanceof AdminApiError) {
    if (err.status === 503) return "メールを送れない設定です（RESEND_API_KEY が未設定）。何も変更していません。";
    if (err.status === 429) return "同じアドレスへのメールが上限（1 時間に 3 通）です。しばらく待ってください。何も変更していません。";
    if (err.status === 404) return "利用者が見つかりません。一覧を読み込み直してください。";
  }
  return "リセットに失敗しました。もう一度お試しください。";
}

export function AdminResetDialog({ token, userId, email, onClose, onDone, onAuthError }: Props) {
  const [deletePasskeys, setDeletePasskeys] = useState(true);
  const [done, setDone] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: () => resetAdminUser(token, userId, deletePasskeys),
    onSuccess: () => {
      setDone(new Date().toLocaleString("ja-JP"));
      onDone();
    },
    onError: (err) => {
      if (err instanceof AdminApiError && (err.status === 401 || err.status === 403)) onAuthError();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${email} をリセット`}
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-5 shadow-xl"
      >
        <h3 className="text-base font-bold text-gray-900">{email} をリセットしますか？</h3>
        {done ? (
          <>
            <p role="status" className="text-sm text-green-700">
              実行しました（{done}）。{email} へ再登録リンクを送り、全端末のログインを終了しました。
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700"
              >
                閉じる
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-700">実行すると、次のことが起きます。</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
              <li>
                全端末のログインを終了します（ログインしたままの端末を含みます。今のアクセスは、最長 15 分で切れます）。
              </li>
              <li>再登録リンク（1 時間有効）を、このアドレスへ送ります。</li>
            </ul>
            <label className="flex items-start gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                checked={deletePasskeys}
                onChange={(event) => setDeletePasskeys(event.target.checked)}
                className="mt-1"
              />
              登録済みのパスキーも削除する（端末を失くしたとき・乗っ取りが心配なとき）
            </label>
            {reset.isError && (
              <p role="alert" className="text-sm text-red-600">
                {describeResetError(reset.error)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                やめる
              </button>
              <button
                type="button"
                disabled={reset.isPending}
                onClick={() => reset.mutate()}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                リセットを実行
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
