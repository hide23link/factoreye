/**
 * セットアップガイド（5 分で体験する画面）。次の4段階で進む:
 * 1. センサーを登録する 2. テストデータを送る（デバイスの代わりに、コードを実行する）
 * 3. データを受信したことを確かめる 4. ダッシュボードを作って、グラフを表示する
 * 2 のデータを受信すると、自動で次の段階へ進む（画面を取り直して確かめる）。
 *
 * 【誰が使うか】App.tsx が、メニューで「セットアップガイド」を選んだときに出す。引数（props）はない。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useSensorReadings } from "../hooks/queries";
import { addWidget, createDashboard, createSensor } from "../lib/api";
import { CODE_TABS, ingestSnippets, type CodeTab } from "../lib/ingest-snippets";
import { validateSensorBasics } from "../lib/sensor-validation";
import { describeActionError, errorStatus } from "../lib/errors";
import { FREE_TIER_LIMIT_MESSAGE, isFreeTierLimitError } from "../lib/freeTier";
import { useUiStore } from "../store/useUiStore";
import { UnitSelect } from "./UnitSelect";

// 段階の番号（1〜4）
type Step = 1 | 2 | 3 | 4;

/** 画面上部の進み具合（4 段階）。今の段階を強調し、済んだ段階には ✓ を付ける。 */
function StepHeader({ step }: { step: Step }) {
  const labels = ["センサー登録", "データ送信", "ダッシュボード作成", "完了"];
  return (
    <div className="mb-6 flex items-center gap-2 text-xs text-gray-500">
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

/** セットアップガイドの本体。段階ごとの状態（センサー・ダッシュボードの ID など）を持つ。 */
export function SetupWizard() {
  const [step, setStep] = useState<Step>(1);
  // マウントの度に末尾をユニーク化する（ガイドを2回目以降実行しても
  // 前回作成した「デモセンサー」とname/ingestKeyが衝突して無言で失敗しないように）
  const [suffix] = useState(() => Date.now().toString(36));
  const [name, setName] = useState(() => `デモセンサー-${suffix}`);
  const [ingestKey, setIngestKey] = useState(() => `demo-sensor-${suffix}`);
  const [unit, setUnit] = useState("°C");
  const [sensorId, setSensorId] = useState<string | null>(null);
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [codeTab, setCodeTab] = useState<CodeTab>("curl");
  const queryClient = useQueryClient();
  const setView = useUiStore((s) => s.setView);
  const selectDashboard = useUiStore((s) => s.selectDashboard);

  const { data: readingsData } = useSensorReadings(step === 2 ? sensorId : null, 24);

  // 段階2でデータが1件でも届いたら、段階3へ自動で進める
  useEffect(() => {
    if (step === 2 && readingsData && readingsData.total > 0) {
      setStep(3);
    }
  }, [step, readingsData]);

  // エラーの種類を、利用者に分かる文言にする（上限・名前の重複・その他）
  const describeError = (e: Error): string => {
    if (isFreeTierLimitError(e)) return FREE_TIER_LIMIT_MESSAGE;
    if (errorStatus(e) === 409)
      return "その名前またはIngest Keyは既に使われています。別の値に変更して再試行してください。";
    // API の生のメッセージ（英語・JSON）は出さず、操作の失敗として案内する
    return describeActionError(e, "セットアップ");
  };

  // 段階1: センサーを作る（成功したら、そのセンサーの ID を覚えて段階2へ進む）
  const createSensorMutation = useMutation({
    mutationFn: () => createSensor({ name: name.trim(), ingestKey: ingestKey.trim(), unit: unit.trim() }),
    onSuccess: (sensor) => {
      void queryClient.invalidateQueries({ queryKey: ["sensors"] });
      setErrorMessage(null);
      setSensorId(sensor.id);
      setStep(2);
    },
    onError: (e: Error) => setErrorMessage(describeError(e)),
  });

  // 段階4: ダッシュボードを作り、そこへ、送られたセンサーのグラフを1つ置く
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
      setErrorMessage(null);
      setDashboardId(id);
      setStep(4);
    },
    onError: (e: Error) => setErrorMessage(describeError(e)),
  });

  const codeSnippets = ingestSnippets(ingestKey);

  return (
    <div className="mx-auto max-w-xl p-4">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">セットアップガイド</h1>
      <p className="mb-6 text-sm text-gray-500">
        5分でFactorEyeの基本的な使い方を体験できます。
      </p>

      <StepHeader step={step} />

      {errorMessage && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

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
              // 空欄のまま進めない（理由を出す）。サーバーの 422 を待たない
              const problem = validateSensorBasics({ name, unit, ingestKey });
              setErrorMessage(problem);
              if (!problem) createSensorMutation.mutate();
            }}
          >
            <label className="block text-sm">
              名前
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 block w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
            <label className="block text-sm">
              Ingest Key（デバイスが送信時に使う識別子）
              <input
                value={ingestKey}
                onChange={(event) => setIngestKey(event.target.value)}
                className="mt-1 block w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
            <label className="block text-sm">
              単位
              <UnitSelect value={unit} onChange={setUnit} className="mt-1 flex" />
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
            お使いの環境に合わせて下のコードを実行してください（<code>INGEST_API_KEY</code>
            はbackendの<code>.env</code>に設定した値に置き換えます）。受信すると自動で次へ進みます。
            backend を <code>INGEST_AUTH=off</code>（キーなしの取り込み）で動かしている場合は、API キーは不要です
            （curl は <code>X-API-Key</code> の行を外し、Arduino・Python は空文字 <code>&quot;&quot;</code> を渡します）。
          </p>

          <div className="mb-2 flex gap-1 border-b border-gray-200">
            {CODE_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setCodeTab(tab.value)}
                className={
                  codeTab === tab.value
                    ? "border-b-2 border-blue-600 px-2 py-1.5 text-xs font-medium text-blue-600"
                    : "px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700"
                }
              >
                {tab.label}
              </button>
            ))}
          </div>

          <pre className="mb-3 overflow-x-auto rounded bg-gray-900 p-3 text-xs text-gray-100">
            {codeSnippets[codeTab]}
          </pre>
          {codeTab === "arduino" && (
            <p className="mb-3 text-xs text-gray-500">
              ライブラリの入手方法・詳細は <code>clients/arduino-m5stack/README.md</code> を参照してください。
            </p>
          )}
          {codeTab === "python" && (
            <p className="mb-3 text-xs text-gray-500">
              入手方法・詳細は <code>clients/raspberry-pi/README.md</code> を参照してください。
            </p>
          )}
          <p className="text-xs text-gray-500">データの到着を待っています...（5秒ごとに自動確認）</p>
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
        className="mt-4 text-xs text-gray-500 hover:text-gray-600"
      >
        スキップしてダッシュボード一覧へ
      </button>
    </div>
  );
}
