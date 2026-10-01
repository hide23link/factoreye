import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useSensorReadings } from "../hooks/queries";
import { addWidget, createDashboard, createSensor } from "../lib/api";
import { useUiStore } from "../store/useUiStore";

type Step = 1 | 2 | 3 | 4;

function StepHeader({ step }: { step: Step }) {
  const labels = ["センサー登録", "データ送信", "ダッシュボード作成", "完了"];
  return (
    <div className="mb-6 flex items-center gap-2 text-xs text-gray-400">
      {labels.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <div key={label} className="flex items-center gap-2">
            <span
              className={
                active
                  ? "flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white"
                  : done
                    ? "flex h-5 w-5 items-center justify-center rounded-full bg-green-500 text-white"
                    : "flex h-5 w-5 items-center justify-center rounded-full bg-gray-200"
              }
            >
              {done ? "✓" : n}
            </span>
            <span className={active ? "font-medium text-gray-700" : ""}>{label}</span>
            {n < 4 && <span className="mx-1 text-gray-300">—</span>}
          </div>
        );
      })}
    </div>
  );
}

export function SetupWizard() {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("デモセンサー");
  const [ingestKey, setIngestKey] = useState("demo-sensor-1");
  const [unit, setUnit] = useState("C");
  const [sensorId, setSensorId] = useState<string | null>(null);
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const setView = useUiStore((s) => s.setView);
  const selectDashboard = useUiStore((s) => s.selectDashboard);

  const { data: readingsData } = useSensorReadings(step === 2 ? sensorId : null, 24);

  useEffect(() => {
    if (step === 2 && readingsData && readingsData.total > 0) {
      setStep(3);
    }
  }, [step, readingsData]);

  const createSensorMutation = useMutation({
    mutationFn: () => createSensor({ name, ingestKey, unit }),
    onSuccess: (sensor) => {
      void queryClient.invalidateQueries({ queryKey: ["sensors"] });
      setSensorId(sensor.id);
      setStep(2);
    },
  });

  const createDashboardMutation = useMutation({
    mutationFn: async () => {
      if (!sensorId) throw new Error("センサーが未登録です");
      const dashboard = await createDashboard({ name: "はじめてのダッシュボード" });
      await addWidget(dashboard.id, {
        type: "SensorGraph",
        sensorId,
        gridColumn: 1,
        gridRow: 1,
        gridWidth: 6,
        gridHeight: 6,
        config: { timeRangeHours: 24, graphType: "line" },
      });
      return dashboard.id;
    },
    onSuccess: (id) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      setDashboardId(id);
      setStep(4);
    },
  });

  const curlCommand = sensorId
    ? `curl -X POST http://localhost:8000/api/ingest/readings \\\n  -H "X-API-Key: <.envのINGEST_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"ingestKey": "${ingestKey}", "value": 42.0}'`
    : "";

  return (
    <div className="mx-auto max-w-xl p-4">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">セットアップガイド</h1>
      <p className="mb-6 text-sm text-gray-500">
        5分でFactorEyeの基本的な使い方を体験できます。
      </p>

      <StepHeader step={step} />

      {step === 1 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 font-semibold text-gray-900">1. センサーを登録しましょう</h2>
          <p className="mb-3 text-sm text-gray-500">
            まずは監視したい対象を1つ登録します（後で何個でも追加できます）。
          </p>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              createSensorMutation.mutate();
            }}
          >
            <label className="block text-sm">
              名前
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 block w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
            <label className="block text-sm">
              Ingest Key（デバイスが送信時に使う識別子）
              <input
                value={ingestKey}
                onChange={(e) => setIngestKey(e.target.value)}
                className="mt-1 block w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
            <label className="block text-sm">
              単位
              <input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="mt-1 block w-24 rounded border border-gray-300 px-2 py-1"
              />
            </label>
            <button
              type="submit"
              disabled={createSensorMutation.isPending}
              className="mt-2 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              次へ
            </button>
          </form>
        </div>
      )}

      {step === 2 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 font-semibold text-gray-900">2. テストデータを送ってみましょう</h2>
          <p className="mb-3 text-sm text-gray-500">
            下のコマンドをターミナルで実行してください（<code>INGEST_API_KEY</code>
            はbackendの<code>.env</code>に設定した値に置き換えます）。受信すると自動で次へ進みます。
          </p>
          <pre className="mb-3 overflow-x-auto rounded bg-gray-900 p-3 text-xs text-gray-100">
            {curlCommand}
          </pre>
          <p className="text-xs text-gray-400">データの到着を待っています...（5秒ごとに自動確認）</p>
        </div>
      )}

      {step === 3 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 font-semibold text-gray-900">3. データを受信しました！</h2>
          <p className="mb-3 text-sm text-gray-500">
            続けてダッシュボードを自動作成し、グラフウィジェットを配置します。
          </p>
          <button
            type="button"
            onClick={() => createDashboardMutation.mutate()}
            disabled={createDashboardMutation.isPending}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            ダッシュボードを作成
          </button>
        </div>
      )}

      {step === 4 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 text-center">
          <h2 className="mb-2 font-semibold text-gray-900">🎉 セットアップ完了！</h2>
          <p className="mb-4 text-sm text-gray-500">
            センサー登録からダッシュボード表示まで一通り体験できました。
          </p>
          <button
            type="button"
            onClick={() => {
              if (dashboardId) selectDashboard(dashboardId);
            }}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            ダッシュボードを見る
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setView("main")}
        className="mt-4 text-xs text-gray-400 hover:text-gray-600"
      >
        スキップしてダッシュボード一覧へ
      </button>
    </div>
  );
}
