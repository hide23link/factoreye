import { useEffect } from "react";

import { useHealthStore } from "./store/useHealthStore";

function App() {
  const { health, error, loading, check } = useHealthStore();

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 text-gray-900">
      <h1 className="text-3xl font-bold">FactorEye</h1>
      <p className="text-gray-500">工場監視OSS — Phase 0 MVP</p>
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm">
        {loading && "backend 接続確認中..."}
        {error && <span className="text-red-600">backend 接続エラー: {error}</span>}
        {health && (
          <span className={health.status === "ok" ? "text-green-600" : "text-amber-600"}>
            backend: {health.status}（db: {health.services.database}）
          </span>
        )}
      </div>
    </div>
  );
}

export default App;
