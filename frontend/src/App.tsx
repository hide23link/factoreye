import { useEffect } from "react";

import { LoginPage } from "./components/auth/LoginPage";
import { DashboardListPage } from "./components/DashboardListPage";
import { DashboardView } from "./components/DashboardView";
import { SettingsPage } from "./components/SettingsPage";
import { SetupWizard } from "./components/SetupWizard";
import { fetchMe, refreshTokens } from "./lib/api";
import { getStoredRefreshToken, useAuthStore } from "./store/useAuthStore";
import { useHealthStore } from "./store/useHealthStore";
import { useUiStore } from "./store/useUiStore";
import type { AppView } from "./store/useUiStore";

const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

const NAV_ITEMS: { value: AppView; label: string }[] = [
  { value: "main", label: "ダッシュボード" },
  { value: "settings", label: "設定" },
  { value: "wizard", label: "セットアップガイド" },
];

function HealthBadge() {
  const { health, error, check } = useHealthStore();

  useEffect(() => {
    void check();
    const interval = setInterval(() => void check(), 30000);
    return () => clearInterval(interval);
  }, [check]);

  const label = error ? "backend未接続" : health?.status === "ok" ? "backend接続中" : "backend確認中";
  const color = error ? "bg-red-400" : health?.status === "ok" ? "bg-green-400" : "bg-gray-300";

  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-400">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </div>
  );
}

function UserBadge() {
  const me = useAuthStore((s) => s.me);
  const clearAuth = useAuthStore((s) => s.clearAuth);

  if (!IS_MULTI_TENANT || !me) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <span>{me.workspaceName}</span>
      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-400">{me.plan}</span>
      <button
        type="button"
        onClick={clearAuth}
        className="text-gray-400 hover:text-gray-600"
      >
        ログアウト
      </button>
    </div>
  );
}

function Nav() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <nav className="flex gap-1">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => setView(item.value)}
          className={
            view === item.value
              ? "rounded bg-gray-900 px-3 py-1.5 text-sm text-white"
              : "rounded px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
          }
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function AppShell() {
  const view = useUiStore((s) => s.view);
  const selectedDashboardId = useUiStore((s) => s.selectedDashboardId);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2">
        <div className="flex items-center gap-4">
          <span className="text-lg font-bold">FactorEye</span>
          <Nav />
        </div>
        <div className="flex items-center gap-4">
          <UserBadge />
          <HealthBadge />
        </div>
      </header>
      <main>
        {view === "settings" && <SettingsPage />}
        {view === "wizard" && <SetupWizard />}
        {view === "main" &&
          (selectedDashboardId ? (
            <DashboardView dashboardId={selectedDashboardId} />
          ) : (
            <DashboardListPage />
          ))}
      </main>
    </div>
  );
}

function App() {
  const { accessToken, isInitializing, setInitializing, setAuth, clearAuth } = useAuthStore();

  // multi-tenant: ページロード時にリフレッシュトークンでセッション復元
  useEffect(() => {
    if (!IS_MULTI_TENANT) {
      setInitializing(false);
      return;
    }

    const stored = getStoredRefreshToken();
    if (!stored) {
      setInitializing(false);
      return;
    }

    void (async () => {
      try {
        const tokens = await refreshTokens(stored);
        const me = await fetchMe(tokens.accessToken);
        setAuth(tokens.accessToken, tokens.refreshToken, me);
      } catch {
        clearAuth();
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // multi-tenant かつセッション復元中
  if (IS_MULTI_TENANT && isInitializing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-400">読み込み中...</div>
      </div>
    );
  }

  // multi-tenant かつ未認証 → ログインページ
  if (IS_MULTI_TENANT && !accessToken) {
    return <LoginPage onAuthenticated={() => {}} />;
  }

  return <AppShell />;
}

export default App;
