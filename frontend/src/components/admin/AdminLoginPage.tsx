/**
 * 管理者のログイン画面（管理者 ID とパスワード）。
 * 失敗の理由は、状態コードで区別する（401 は ID・パスワードの誤り、429 は試行回数の超過、それ以外は接続・サーバーの問題）。
 * パスワードは、送信のあと必ず画面から消す（再表示しない）。
 *
 * 【誰が使うか】AdminApp.tsx が、管理者トークンが無いときに出す。引数（props）はない。
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { adminLogin } from "../../lib/adminApi";
import { describeAdminLoginError } from "../../lib/errors";
import { useAdminStore } from "../../store/useAdminStore";

/** 管理者ログインのフォーム。 */
export function AdminLoginPage() {
  const setToken = useAdminStore((s) => s.setToken);
  const [adminId, setAdminId] = useState("");
  const [password, setPassword] = useState("");

  // ログイン: 成功したらトークンを保存する。終わったら（成否に関わらず）パスワードの入力を消す
  const loginMutation = useMutation({
    mutationFn: () => adminLogin(adminId.trim(), password),
    onSuccess: (result) => setToken(result.accessToken),
    onSettled: () => setPassword(""),
  });

  // 失敗の文言。429 は、試行回数の制限（1分に5回まで）に当たったとき
  const errorMessage = loginMutation.isError
    ? describeAdminLoginError(loginMutation.error)
    : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <form
        className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (adminId.trim() && password) loginMutation.mutate();
        }}
      >
        <h1 className="mb-1 text-lg font-bold text-gray-900">FactorEye 管理者</h1>
        <p className="mb-5 text-xs text-gray-400">管理者IDとパスワードでログインしてください</p>

        <label className="mb-3 block text-sm text-gray-700">
          管理者ID
          <input
            value={adminId}
            onChange={(event) => setAdminId(event.target.value)}
            autoComplete="username"
            className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="mb-4 block text-sm text-gray-700">
          パスワード
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>

        {errorMessage && <p className="mb-3 text-sm text-red-600">{errorMessage}</p>}

        <button
          type="submit"
          disabled={loginMutation.isPending}
          className="w-full rounded bg-gray-900 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
        >
          ログイン
        </button>
      </form>
    </div>
  );
}
