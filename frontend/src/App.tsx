/**
 * 画面の土台（ヘッダー、メニュー、画面の切り替え）と、ログインの判定。
 *
 * 動作モード:
 * - self-hosted（VITE_AUTH_MODE が multi_tenant 以外）: ログイン無しで、すぐ画面を表示する
 * - SaaS（multi_tenant）: 起動時に保存されたリフレッシュトークンで復元を試み、
 *   復元できなければログイン画面を表示する
 *
 * 【誰が使うか】main.tsx が、通常の画面として描画する（/admin 以外のとき）。引数（props）はない。
 * 【画面の切り替え】ルーター（URL で画面を替える道具）は使わず、useUiStore の view を見て、
 * ダッシュボード・全体監視・設定・セットアップガイドのどれを出すかを選ぶ。
 * 【外枠の形】操作室の計器盤にならい、パソコンは左の縦のメニュー、上の帯に「警報・注意」の表示灯・接続状態・時計を置く。
 * スマホは下のメニュー。色は theme.css（画面の明るさは 設定 › 表示）。
 * リンク（?dashboard=…&graph=…&range=…m）で開いたときは、ヘッダー・メニューを出さず、そのグラフ 1 つの画面（GraphLinkView）を出す。
 */
import { Suspense, useEffect } from "react";

import { LoginPage } from "./components/auth/LoginPage";
import { DashboardListPage } from "./components/DashboardListPage";
import { DashboardTabs } from "./components/DashboardTabs";
import { useAlarms } from "./hooks/queries";
import { useNow } from "./hooks/useNow";
import { fetchMe, logout, refreshTokens } from "./lib/api";
import { clearGraphLinkFromUrl } from "./lib/graph-link";
import { clearImpersonation, readImpersonation } from "./lib/impersonation";
import { getStoredRefreshToken, useAuthStore } from "./store/useAuthStore";
import { useHealthStore } from "./store/useHealthStore";
import { startThemeWatch } from "./store/useThemeStore";
import { useUiStore } from "./store/useUiStore";
import type { AppView } from "./store/useUiStore";
import type { LegalKind } from "./components/LegalPage";
import { ChunkErrorBoundary } from "./components/ChunkErrorBoundary";
import { lazyNamed } from "./lib/lazyWithRetry";

// 画面ごとに分割し、開いた時に読み込む（ダッシュボードのグラフ用ライブラリ recharts などを初期ロードから外す）
const DashboardView = lazyNamed(() => import("./components/DashboardView"), "DashboardView");
const SettingsPage = lazyNamed(() => import("./components/SettingsPage"), "SettingsPage");
const SetupWizard = lazyNamed(() => import("./components/SetupWizard"), "SetupWizard");
const OverviewPage = lazyNamed(() => import("./components/OverviewPage"), "OverviewPage");
const LegalPage = lazyNamed(() => import("./components/LegalPage"), "LegalPage");
const GraphLinkView = lazyNamed(() => import("./components/link/GraphLinkView"), "GraphLinkView");

/** 遅延読み込み中の表示。他の「読み込み中」と同じ見た目にする。 */
function PageFallback() {
  return <p className="p-4 text-sm text-gray-500">読み込み中...</p>;
}

// ログイン無しで読める公開の文書（パスと画面の対応）
const LEGAL_PATHS: Record<string, LegalKind> = { "/privacy": "privacy", "/terms": "terms" };

// ビルド時に決まる動作モード（.env の VITE_AUTH_MODE）。true なら SaaS 版
const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

// メニューの項目（画面の名前と、切り替える先と、絵）。名前はボタンの名前として、テスト（e2e）でも使う
const NAV_ITEMS: { value: AppView; label: string; short: string; icon: string[] }[] = [
  { value: "main", label: "ダッシュボード", short: "計器盤", icon: ["M3 17l5-6 4 4 4-7 5 9", "M3 21h18"] },
  { value: "overview", label: "全体監視", short: "全体", icon: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"] },
  { value: "settings", label: "設定", short: "設定", icon: ["M12 9a3 3 0 100 6 3 3 0 000-6z", "M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"] },
  { value: "wizard", label: "セットアップガイド", short: "ガイド", icon: ["M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5A2.5 2.5 0 004 5.5z", "M20 17v4H6.5"] },
];

/** メニューの絵（線の絵）。飾りなので読み上げない */
function NavIcon({ paths, size = 20 }: { paths: string[]; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** バックエンドとの接続状態。つながっていれば「LIVE」、切れていれば赤で知らせる。30 秒ごとに確かめ直す。 */
function HealthBadge() {
  const { health, error, check } = useHealthStore();

  useEffect(() => {
    // 表示の直後に1回確かめ、以後は30秒ごとに確かめる（画面を閉じたら止める）
    void check();
    const interval = setInterval(() => void check(), 30000);
    return () => clearInterval(interval);
  }, [check]);

  const label = error ? "backend未接続" : health?.status === "ok" ? "LIVE" : "backend確認中";
  const color = error ? "var(--fe-red)" : health?.status === "ok" ? "var(--fe-ok)" : "var(--fe-mut)";

  return (
    <div className="flex items-center gap-1.5 font-num text-xs" style={{ color }} title={error ? "サーバーにつながっていません" : "サーバーにつながっています"}>
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </div>
  );
}

/**
 * 警報・注意の表示灯（操作室のマスター警告灯と同じ考え方）。発生中で、まだ確認していないアラームの数を出す。
 * 0 件のときは暗く、1 件以上で点く。押すと全体監視へ移る。
 */
function Annunciators() {
  const { data } = useAlarms("active", 200);
  const setView = useUiStore((s) => s.setView);
  const alarms = data?.alarms ?? [];
  const critical = alarms.filter((alarm) => alarm.severity === "critical").length;
  // 合計は API の total（200 件を超えても正しい数）。重さの内訳は取れた分で数え、残りは注意に入れる
  const warning = Math.max(0, (data?.total ?? alarms.length) - critical);
  const lamp = (count: number, color: string, onText: string) =>
    count > 0
      ? { borderColor: color, background: onText === "fill" ? color : "transparent", color: onText === "fill" ? "var(--fe-on-red)" : color }
      : { borderColor: "var(--fe-line)", background: "transparent", color: "var(--fe-mut)" };

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => setView("overview")}
        className="h-8 rounded border px-2.5 text-xs font-bold"
        style={lamp(critical, "var(--fe-red)", "fill")}
        aria-label={`警報 ${critical} 件（全体監視を開く）`}
      >
        警報 <span className="font-num">{critical}</span>
      </button>
      <button
        type="button"
        onClick={() => setView("overview")}
        className="h-8 rounded border px-2.5 text-xs font-bold"
        style={lamp(warning, "var(--fe-amb)", "line")}
        aria-label={`注意 ${warning} 件（全体監視を開く）`}
      >
        注意 <span className="font-num">{warning}</span>
      </button>
    </div>
  );
}

/** 時計（日本時間、秒まで）。操作室の時計と同じく、いつの値を見ているかをすぐ確かめられるように */
function Clock() {
  const now = useNow(1000);
  const time = new Date(now).toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return (
    <span className="font-num text-base font-bold text-gray-900" aria-label={`現在 ${time} 日本時間`}>
      {time}
      <span className="ml-1 text-[10px] font-normal text-gray-500">JST</span>
    </span>
  );
}

/** SaaS 版で、ログイン中のワークスペース名・プラン・ログアウトを表示する（self-hosted では何も出さない）。 */
function UserBadge() {
  const me = useAuthStore((s) => s.me);
  if (!IS_MULTI_TENANT || !me) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <span>{me.workspaceName}</span>
      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">{me.plan}</span>
      <button
        type="button"
        onClick={() => void logout()}
        className="text-gray-500 hover:text-gray-600"
      >
        ログアウト
      </button>
    </div>
  );
}

/** パソコンの左の縦のメニュー。今の画面に印を付ける。スマホでは出さない（下のメニューを使う） */
function SideRail() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <nav aria-label="メインメニュー" className="sticky top-0 hidden h-screen w-16 shrink-0 flex-col items-center gap-1 border-r border-gray-200 py-3 sm:flex" style={{ background: "var(--fe-chrome)" }}>
      <BrandMark />
      {NAV_ITEMS.map((item) => {
        const active = view === item.value;
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => setView(item.value)}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            title={item.label}
            className={`flex w-14 flex-col items-center gap-0.5 rounded py-1.5 text-[10px] ${
              active ? "bg-gray-100 text-gray-900 shadow-[inset_2px_0_0_rgb(var(--blue-600))]" : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            <NavIcon paths={item.icon} />
            <span aria-hidden="true">{item.short}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** 目の形の印（ロゴ）。飾りなので読み上げない */
function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true" className="mb-2 shrink-0">
      <rect x="1" y="1" width="24" height="24" rx="6" fill="#161c22" stroke="#2e3742" />
      <path d="M5 13c2.4-4 5-6 8-6s5.6 2 8 6c-2.4 4-5 6-8 6s-5.6-2-8-6z" fill="none" stroke="#e6edf3" strokeWidth="1.6" />
      <circle cx="13" cy="13" r="2.6" fill="#3fd3f5" />
    </svg>
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
    <nav aria-label="画面の切り替え" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-gray-200 sm:hidden" style={{ background: "var(--fe-chrome)" }}>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => setView(item.value)}
          aria-current={view === item.value ? "page" : undefined}
          className={`flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11px] ${
            view === item.value ? "font-bold text-gray-900 shadow-[inset_0_2px_0_rgb(var(--blue-600))]" : "text-gray-500"
          }`}
        >
          <NavIcon paths={item.icon} size={20} />
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/** ログイン後（または self-hosted）の画面。リンクで開いたときはグラフ 1 つの画面、それ以外はふだんの枠（MainShell）。 */
function AppShell() {
  const view = useUiStore((s) => s.view);
  const selectedDashboardId = useUiStore((s) => s.selectedDashboardId);
  const graphLink = useUiStore((s) => s.graphLink);
  const linkNotFound = useUiStore((s) => s.linkNotFound);

  // リンクの形がおかしい（ID が片方だけ）ときは、URL のリンクの部分を消す（一覧に黄色の帯が出る）
  useEffect(() => {
    if (linkNotFound) clearGraphLinkFromUrl();
  }, [linkNotFound]);

  if (graphLink) {
    return (
      <ChunkErrorBoundary>
        <Suspense fallback={<PageFallback />}>
          <GraphLinkView link={graphLink} />
        </Suspense>
      </ChunkErrorBoundary>
    );
  }
  return <MainShell view={view} selectedDashboardId={selectedDashboardId} />;
}

/** 画面の名前（上の帯に出す） */
const VIEW_TITLES: Record<AppView, string> = {
  main: "ダッシュボード",
  overview: "全体監視",
  settings: "設定",
  wizard: "セットアップガイド",
};

/** メニュー・上の帯つきの、ふだんの画面の枠。 */
function MainShell({ view, selectedDashboardId }: { view: AppView; selectedDashboardId: string | null }) {
  // 画面表示モード（キオスク）では、メニューと上の帯を隠す
  const kiosk = useUiStore((s) => s.kiosk) && view === "main" && selectedDashboardId !== null;

  return (
    <div className="flex min-h-screen bg-gray-50 text-gray-900">
      {!kiosk && <SideRail />}
      <div className="flex min-w-0 flex-1 flex-col">
        {!kiosk && <ImpersonationBanner />}
        {!kiosk && (
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-1.5 sm:px-4" style={{ background: "var(--fe-chrome)" }}>
            <div className="flex min-w-0 items-center gap-3">
              <span className="shrink-0 text-base font-bold tracking-wide">FactorEye</span>
              <span className="hidden truncate text-sm text-gray-500 sm:inline">{VIEW_TITLES[view]}</span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <UserBadge />
              <Annunciators />
              <HealthBadge />
              <Clock />
            </div>
          </header>
        )}
        {!kiosk && view === "main" && <DashboardTabs />}
        <main className={kiosk ? "" : "pb-20 sm:pb-0"}>
          {/* 画面を切り替えたら、前の読み込み失敗の表示は消す（key。一覧と詳細の行き来も含む） */}
          <ChunkErrorBoundary key={`${view}:${selectedDashboardId ?? ""}`}>
            <Suspense fallback={<PageFallback />}>
              {view === "settings" && <SettingsPage />}
              {view === "wizard" && <SetupWizard />}
              {view === "overview" && <OverviewPage />}
              {view === "main" &&
                (selectedDashboardId ? (
                  <DashboardView dashboardId={selectedDashboardId} />
                ) : (
                  <DashboardListPage />
                ))}
            </Suspense>
          </ChunkErrorBoundary>
        </main>
        {!kiosk && <BottomNav />}
      </div>
    </div>
  );
}

/**
 * 画面の最上位。認証の状態に応じて、読み込み中・ログイン画面・本体のいずれかを出す。
 */
function App() {
  const { accessToken, isInitializing, setInitializing, setAuth, setImpersonated, clearAuth } =
    useAuthStore();

  // 画面の明るさ（設定 › 表示）を付け、「端末に合わせる」のときは端末の設定の変化を追いかける
  useEffect(() => startThemeWatch(), []);

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
    return (
      <ChunkErrorBoundary>
        <Suspense fallback={<PageFallback />}>
          <LegalPage kind={legalKind} />
        </Suspense>
      </ChunkErrorBoundary>
    );
  }

  // multi-tenant かつセッション復元中
  if (IS_MULTI_TENANT && isInitializing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">読み込み中...</div>
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
