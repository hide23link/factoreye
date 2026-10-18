/**
 * 管理者画面（/admin）の土台。
 * 管理者トークンが無ければログイン画面を、あれば利用者の一覧画面を表示する。
 * 通常画面（App.tsx）とは、ログインも状態も別々。
 *
 * 【誰が使うか】main.tsx が、URL が /admin のときだけ、遅延読み込みして出す。引数（props）はない。
 */
import { useCallback } from "react";

import { useAdminStore } from "../../store/useAdminStore";
import { AdminLoginPage } from "./AdminLoginPage";
import { AdminUsersPage } from "./AdminUsersPage";

/** 管理者画面の本体。 */
export function AdminApp() {
  // 認証の失効（401）が起きたら、トークンを消してログイン画面へ戻す

  const token = useAdminStore((s) => s.token);
  const clearToken = useAdminStore((s) => s.clearToken);
  const onAuthError = useCallback(() => clearToken(), [clearToken]);

  if (!token) return <AdminLoginPage />;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
        <h1 className="text-base font-bold text-gray-900">FactorEye 管理者</h1>
        <button
          type="button"
          onClick={clearToken}
          className="text-sm text-gray-500 hover:text-gray-800"
        >
          ログアウト
        </button>
      </header>
      <main className="mx-auto max-w-7xl p-6">
        <AdminUsersPage token={token} onAuthError={onAuthError} />
      </main>
    </div>
  );
}
