import { useEffect } from "react";

import { DashboardListPage } from "./components/DashboardListPage";
import { DashboardView } from "./components/DashboardView";
import { SettingsPage } from "./components/SettingsPage";
import { SetupWizard } from "./components/SetupWizard";
import { useHealthStore } from "./store/useHealthStore";
import { useUiStore } from "./store/useUiStore";
import type { AppView } from "./store/useUiStore";

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

function App() {
  const view = useUiStore((s) => s.view);
  const selectedDashboardId = useUiStore((s) => s.selectedDashboardId);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2">
        <div className="flex items-center gap-4">
          <span className="text-lg font-bold">FactorEye</span>
          <Nav />
        </div>
        <HealthBadge />
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

export default App;
