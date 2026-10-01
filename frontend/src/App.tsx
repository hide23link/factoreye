import { useEffect } from "react";

import { DashboardListPage } from "./components/DashboardListPage";
import { DashboardView } from "./components/DashboardView";
import { useHealthStore } from "./store/useHealthStore";
import { useUiStore } from "./store/useUiStore";

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

function App() {
  const selectedDashboardId = useUiStore((s) => s.selectedDashboardId);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2">
        <span className="text-lg font-bold">FactorEye</span>
        <HealthBadge />
      </header>
      <main>
        {selectedDashboardId ? (
          <DashboardView dashboardId={selectedDashboardId} />
        ) : (
          <DashboardListPage />
        )}
      </main>
    </div>
  );
}

export default App;
