import { useCallback } from "react";

import { useAdminStore } from "../../store/useAdminStore";
import { AdminLoginPage } from "./AdminLoginPage";
import { AdminUsersPage } from "./AdminUsersPage";

// /admin 配下の画面。通常画面（App.tsx）とは別の認証（管理者ID + パスワード）を使う。
export function AdminApp() {
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
