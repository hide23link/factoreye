/**
 * 画面の土台（ヘッダー、メニュー、画面の切り替え）と、ログインの判定。
 *
 * 動作モード:
 * - self-hosted（VITE_AUTH_MODE が multi_tenant 以外）: ログイン無しで、すぐ画面を表示する
 * - SaaS（multi_tenant）: 起動時に保存されたリフレッシュトークンで復元を試み、
 *   復元できなければログイン画面を表示する
 */
import { useEffect } from "react";

import { LoginPage } from "./components/auth/LoginPage";
import { DashboardListPage } from "./components/DashboardListPage";
import { DashboardView } from "./components/DashboardView";
import { SettingsPage } from "./components/SettingsPage";
import { SetupWizard } from "./components/SetupWizard";
import { fetchMe, refreshTokens } from "./lib/api";
import { clearImpersonation, readImpersonation } from "./lib/impersonation";
import { getStoredRefreshToken, useAuthStore } from "./store/useAuthStore";
import { useHealthStore } from "./store/useHealthStore";
import { useUiStore } from "./store/useUiStore";
import type { AppView } from "./store/useUiStore";
import { LegalPage, type LegalKind } from "./components/LegalPage";

// ログイン無しで読める公開の文書（パスと画面の対応）
const LEGAL_PATHS: Record<string, LegalKind> = { "/privacy": "privacy", "/terms": "terms" };

// ビルド時に決まる動作モード（.env の VITE_AUTH_MODE）。true なら SaaS 版
const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

// 上部メニューの項目（画面の名前と、切り替える先）
const NAV_ITEMS: { value: AppView; label: string }[] = [
  { value: "main", label: "ダッシュボード" },
  { value: "settings", label: "設定" },
  { value: "wizard", label: "セットアップガイド" },
];

/** バックエンドとの接続状態を、色の点と文字で示す。30 秒ごとに確かめ直す。 */
function HealthBadge() {
  const { health, error, check } = useHealthStore();

  useEffect(() => {
    // 表示の直後に1回確かめ、以後は30秒ごとに確かめる（画面を閉じたら止める）
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

/** SaaS 版で、ログイン中のワークスペース名・プラン・ログアウトを表示する（self-hosted では何も出さない）。 */
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

/** 上部メニュー。今の画面を強調し、押すと画面を切り替える。 */
function Nav() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <nav className="hidden gap-1 sm:flex">
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

/**
 * 管理者が利用者として閲覧中であることを示す。期限（短い）が過ぎたら、閲覧を終える。
 * 書き込みは記録されることも、ここで伝える。
 */
function ImpersonationBanner() {
  const impersonation = useAuthStore((s) => s.impersonation);
  const clearAuth = useAuthStore((s) => s.clearAuth);

  // 期限が過ぎたら、操作がなくても閲覧を終える
  useEffect(() => {
    if (!impersonation) return;
    const check = () => {
      if (Date.now() >= impersonation.expiresAt) clearAuth();
    };
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, [impersonation, clearAuth]);

  if (!impersonation) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-900"
    >
      <span>
        管理者として閲覧中: {impersonation.email}（{impersonation.workspaceName}）。
        {new Date(impersonation.expiresAt).toLocaleTimeString("ja-JP")} まで。書き込みは記録されます
      </span>
      <button
        type="button"
        onClick={() => {
          clearAuth();
          window.close();
        }}
        className="rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-200"
      >
        閲覧を終える
      </button>
    </div>
  );
}

/** スマホ用の下部ナビゲーション。画面の下に固定し、親指で押しやすい大きさにする（パソコンでは出さない）。 */
function BottomNav() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <nav aria-label="画面の切り替え" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-3 border-t border-gray-200 bg-white sm:hidden">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => setView(item.value)}
          aria-current={view === item.value ? "page" : undefined}
          className={`min-h-14 px-2 text-sm ${view === item.value ? "font-bold text-gray-900" : "text-gray-500"}`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/** ログイン後（または self-hosted）の画面の枠。ヘッダーと、選ばれた画面の本体を並べる。 */
function AppShell() {
  const view = useUiStore((s) => s.view);
  const selectedDashboardId = useUiStore((s) => s.selectedDashboardId);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <ImpersonationBanner />
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-2">
        <div className="flex min-w-0 items-center gap-4 overflow-x-auto">
          <span className="shrink-0 text-lg font-bold">FactorEye</span>
          <Nav />
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <UserBadge />
          <HealthBadge />
        </div>
      </header>
      <main className="pb-20 sm:pb-0">
        {view === "settings" && <SettingsPage />}
        {view === "wizard" && <SetupWizard />}
        {view === "main" &&
          (selectedDashboardId ? (
            <DashboardView dashboardId={selectedDashboardId} />
          ) : (
            <DashboardListPage />
          ))}
      </main>
      <BottomNav />
    </div>
  );
}

/**
 * 画面の最上位。認証の状態に応じて、読み込み中・ログイン画面・本体のいずれかを出す。
 */
function App() {
  const { accessToken, isInitializing, setInitializing, setAuth, setImpersonated, clearAuth } =
    useAuthStore();

  // multi-tenant: ページ読み込み時に、保存されたリフレッシュトークンでセッションを復元する。
  // 成功すれば、アクセストークンと利用者の情報を入れる。失敗（期限切れなど）なら、ログイン状態を消す
  useEffect(() => {
    if (!IS_MULTI_TENANT) {
      setInitializing(false);
      return;
    }

    // 管理者が利用者として閲覧中のタブ: その閲覧のトークンだけを使う（利用者本人のログインには触れない）
    const viewing = readImpersonation();
    if (viewing) {
      void (async () => {
        try {
          const me = await fetchMe(viewing.accessToken);
          setImpersonated(viewing, me);
        } catch {
          // 閲覧を始められなければ、閲覧の情報を消してログイン画面へ（利用者本人のログインは残す）
          clearImpersonation();
          setInitializing(false);
        }
      })();
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

  // 公開の文書（プライバシーポリシー・利用規約）は、ログインの状態に関係なく表示する
  const legalKind = LEGAL_PATHS[window.location.pathname];
  if (legalKind) {
    return <LegalPage kind={legalKind} />;
  }

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
