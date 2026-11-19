/**
 * セットアップガイド（約 5 分で、最初のグラフを出すまでの画面）。縦に 4 つの段階が並ぶ:
 * 1. センサーを登録する 2. テストデータを送る（機器の代わりに、コードを実行する）
 * 3. 計器盤を作る（届いた値を、計器と計器グラフにする） 4. 完了（本物の機器をつなぐ方法へ）
 * 2 は 3 秒ごとに受信を確かめ、値が届くと自動で 3 へ進む。
 * 途中でやめても、進み具合（段階・登録したセンサー）をこの端末に覚えておき、次に開いたとき続きから再開する。
 *
 * 【誰が使うか】App.tsx が、メニューで「セットアップガイド」を選んだときに出す。引数（props）はない。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useDashboards, useSensorReadings } from "../hooks/queries";
import { SERVER_CHECK_INTERVAL_MS } from "../hooks/useServerCheck";
import { addWidget, createDashboard, createSensor } from "../lib/api";
import { describeActionError, errorStatus } from "../lib/errors";
import { FREE_TIER_LIMIT_MESSAGE, isFreeTierLimitError } from "../lib/freeTier";
import { validateSensorBasics } from "../lib/sensor-validation";
import {
  clearSetupProgress,
  completedCount,
  loadSetupProgress,
  saveSetupProgress,
  stepBarStates,
  type SetupProgress,
  type SetupStep,
} from "../lib/setup-progress";
import { useUiStore } from "../store/useUiStore";
import { RegisterForm } from "./setup/RegisterForm";
import { SendDataPanel } from "./setup/SendDataPanel";
import { StepRow, type StepRowState } from "./setup/StepRow";

/** 段階 1 の入力欄と、画面下の「次へ」をつなぐ form の id */
const REGISTER_FORM_ID = "setup-register-form";

/** ダッシュボードの名前 */
const DASHBOARD_NAME = "はじめてのダッシュボード";

/** 覚えておいたセンサー・ダッシュボードが、あとで削除されていたときの案内 */
const SENSOR_GONE_MESSAGE = "登録したセンサーが見つかりません（削除されたようです）。下の「最初からやり直す」で、もう一度登録してください。";
const DASHBOARD_GONE_MESSAGE = "作ったダッシュボードが見つかりません（削除されたようです）。下の「最初からやり直す」で、もう一度作れます。";

/** 進み具合の 4 本の帯の色 */
const BAR_COLOR = { done: "var(--fe-ok)", current: "var(--fe-cy)", todo: "var(--fe-line)" } as const;

/** 画面下の、次へ進む主なボタンの見た目 */
const PRIMARY_BUTTON_CLASS = "h-[34px] rounded bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";

/** 段階の番号から、その行の状態（済み・今・これから）を決める */
function rowState(number: SetupStep, step: SetupStep): StepRowState {
  return number < step ? "done" : number === step ? "current" : "todo";
}

/** 段階の見出しの文字（今の段階だけ大きく濃く、そのほかは小さく） */
function StepTitle({ state, title, detail }: { state: StepRowState; title: string; detail?: string }) {
  return (
    <div>
      <div className={state === "current" ? "text-[15px] font-bold text-gray-900" : state === "done" ? "font-semibold text-gray-900" : "font-semibold text-gray-500"}>
        {title}
      </div>
      {detail && <div className={state === "current" ? "mt-0.5 text-sm text-gray-500" : "text-xs text-gray-500"}>{detail}</div>}
    </div>
  );
}

/** セットアップガイドの本体。段階ごとの状態（センサー・ダッシュボードの ID など）を持つ。 */
export function SetupWizard() {
  // 前に途中でやめていれば、その続きから始める
  const [restored] = useState<SetupProgress>(() => loadSetupProgress());
  const [step, setStep] = useState<SetupStep>(restored.step);
  const [sensor, setSensor] = useState(restored.sensor);
  const [dashboardId, setDashboardId] = useState(restored.dashboardId);
  // 値を待ち始めた時刻（待ち時間の表示に使う）。再開したときは、開いた時刻から数える
  const [waitStartedAt, setWaitStartedAt] = useState(() => Date.now());
  // 名前と Ingest Key の末尾はユニークにする（ガイドを 2 回目以降実行しても、
  // 前回作成した「デモセンサー」と name/ingestKey が衝突して無言で失敗しないように）
  const [name, setName] = useState(() => `デモセンサー-${Date.now().toString(36)}`);
  const [ingestKey, setIngestKey] = useState(() => `demo-sensor-${Date.now().toString(36)}`);
  const [unit, setUnit] = useState("°C");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const setView = useUiStore((s) => s.setView);
  const selectDashboard = useUiStore((s) => s.selectDashboard);

  // 段階 2・3 の間、最後に届いた値を 3 秒ごとに確かめる（最新の 1 件だけ。総件数で「届いた」を判断する）
  const waiting = step === 2 || step === 3;
  const { data: readingsData, error: readingsError } = useSensorReadings(waiting && sensor ? sensor.id : null, 24, 1, SERVER_CHECK_INTERVAL_MS, false);
  const latest = readingsData?.readings[0];
  // 覚えておいたセンサーが、あとで削除されていると、取得が 404 になる（待ち続けても届かない）
  const sensorGone = waiting && errorStatus(readingsError) === 404;
  // 作ったダッシュボードが、あとで削除されていないか（完了の段階でだけ、一覧で確かめる）
  // 取り直している間は、古い一覧（今作ったばかりのダッシュボードが無い）で判断しない
  const { data: dashboards, isFetching: dashboardsFetching } = useDashboards(step === 4);
  const dashboardGone =
    step === 4 && !dashboardsFetching && dashboards !== undefined && dashboardId !== null && !dashboards.some((d) => d.id === dashboardId);

  // 段階 2 でデータが 1 件でも届いたら、段階 3 へ自動で進める
  useEffect(() => {
    if (step === 2 && readingsData && readingsData.total > 0) {
      setStep(3);
    }
  }, [step, readingsData]);

  // 進み具合は、変わるたびにこの端末に覚えておく（途中でやめても続きから再開できる）。
  // 何も始めていない状態（段階 1 でセンサーが無い）は、覚えるものが無いので、残さない
  useEffect(() => {
    if (step === 1 && sensor === null) clearSetupProgress();
    else saveSetupProgress({ step, sensor, dashboardId });
  }, [step, sensor, dashboardId]);

  // エラーの種類を、利用者に分かる文言にする（上限・名前の重複・その他）
  const describeError = (e: Error): string => {
    if (isFreeTierLimitError(e)) return FREE_TIER_LIMIT_MESSAGE;
    if (errorStatus(e) === 409) return "その名前またはIngest Keyは既に使われています。別の値に変更して再試行してください。";
    // API の生のメッセージ（英語・JSON）は出さず、操作の失敗として案内する
    return describeActionError(e, "セットアップ");
  };

  // 段階 1: センサーを作る（成功したら、そのセンサーを覚えて段階 2 へ進む）
  const createSensorMutation = useMutation({
    mutationFn: () => createSensor({ name: name.trim(), ingestKey: ingestKey.trim(), unit: unit.trim() }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["sensors"] });
      setErrorMessage(null);
      setSensor({ id: created.id, name: created.name, ingestKey: created.ingestKey, unit: created.unit });
      setWaitStartedAt(Date.now());
      setStep(2);
    },
    onError: (e: Error) => setErrorMessage(describeError(e)),
  });

  // 段階 3: ダッシュボードを作り、そこへ、計器と計器グラフ（届いたセンサーの値）を置く
  const createDashboardMutation = useMutation({
    mutationFn: async () => {
      if (!sensor) throw new Error("センサーが未登録です");
      const dashboard = await createDashboard({ name: DASHBOARD_NAME });
      await addWidget(dashboard.id, {
        type: "TapeGauge",
        sensorId: sensor.id,
        gridColumn: 1,
        gridRow: 1,
        gridWidth: 3,
        gridHeight: 4,
        config: { decimals: 1 },
      });
      await addWidget(dashboard.id, {
        type: "TrendStack",
        sensorId: sensor.id,
        gridColumn: 1,
        gridRow: 5,
        gridWidth: 12,
        gridHeight: 10,
        config: { sensorIds: [sensor.id] },
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

  // 空欄のまま進めない（理由を出す）。サーバーの 422 を待たない
  const submitSensor = () => {
    const problem = validateSensorBasics({ name, unit, ingestKey });
    setErrorMessage(problem);
    if (!problem) createSensorMutation.mutate();
  };

  // 最初からやり直す（覚えた進み具合を消し、登録するセンサーの名前とキーを新しくする）
  const restart = () => {
    clearSetupProgress();
    const suffix = Date.now().toString(36);
    setName(`デモセンサー-${suffix}`);
    setIngestKey(`demo-sensor-${suffix}`);
    setUnit("°C");
    setSensor(null);
    setDashboardId(null);
    setErrorMessage(null);
    setStep(1);
  };

  const bars = stepBarStates(step);
  // 画面の上に出す知らせ。操作の失敗を先に、なければ、センサー・ダッシュボードが消えていることを案内する
  const notice =
    errorMessage ??
    (sensorGone ? SENSOR_GONE_MESSAGE : dashboardGone ? DASHBOARD_GONE_MESSAGE : null);

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold tracking-wider text-gray-500">セットアップガイド · 約 5 分</span>
        <h1 className="text-[22px] font-bold text-gray-900">最初のグラフを出すまで</h1>
        <p className="text-sm text-gray-500">センサーを登録し、テストデータを送り、計器盤で確かめます。途中でやめても、続きから再開できます。</p>
        <div className="mt-1.5 flex items-center gap-2.5">
          <div className="grid flex-1 grid-cols-4 gap-[3px]" aria-hidden="true">
            {bars.map((state, i) => (
              <span key={i} className="h-1" style={{ background: BAR_COLOR[state] }} />
            ))}
          </div>
          <span className="font-num text-xs text-gray-500">{completedCount(step)} / 4 完了</span>
        </div>
      </header>

      {notice && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {notice}
        </div>
      )}

      <ol className="flex flex-col" aria-label="セットアップの段階">
        <StepRow number={1} state={rowState(1, step)}>
          {step === 1 ? (
            <>
              <StepTitle state="current" title="センサーを登録する" detail="まずは監視したい対象を 1 つ登録します（後で何個でも追加できます）。" />
              <RegisterForm
                formId={REGISTER_FORM_ID}
                name={name}
                onNameChange={setName}
                ingestKey={ingestKey}
                onIngestKeyChange={setIngestKey}
                unit={unit}
                onUnitChange={setUnit}
                onSubmit={submitSensor}
              />
            </>
          ) : (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <StepTitle state="done" title="センサーを登録する" />
                <div className="text-xs text-gray-500">
                  {sensor?.name}&emsp;単位 {sensor?.unit}&emsp;受信キー <span className="font-num text-gray-900">{sensor?.ingestKey}</span>
                </div>
              </div>
              <button type="button" onClick={() => setView("settings")} className="text-xs text-blue-600 hover:underline">
                変更
              </button>
            </div>
          )}
        </StepRow>

        <StepRow number={2} state={rowState(2, step)}>
          {step === 2 && sensor ? (
            <>
              <StepTitle state="current" title="テストデータを送る" detail="機器の代わりに、下のコードをパソコンで 1 回実行してください。" />
              <SendDataPanel ingestKey={sensor.ingestKey} unit={sensor.unit} latest={latest} startedAt={waitStartedAt} />
            </>
          ) : (
            <StepTitle
              state={rowState(2, step)}
              title="テストデータを送る"
              detail={step > 2 ? "値が届きました" : "機器の代わりに、コードをパソコンで 1 回実行します"}
            />
          )}
        </StepRow>

        <StepRow number={3} state={rowState(3, step)}>
          {step === 3 ? (
            <>
              <StepTitle state="current" title="計器盤を作る" detail="届いた値を、目盛り付きのグラフにします。計器と計器グラフのダッシュボードを自動で作ります。" />
              {latest && sensor && (
                <p className="mt-2 text-sm text-gray-500">
                  届いた値&emsp;<b className="font-num text-gray-900">{latest.value}</b> {sensor.unit}
                </p>
              )}
            </>
          ) : (
            <StepTitle
              state={rowState(3, step)}
              title="計器盤を作る"
              detail={step > 3 ? `ダッシュボード「${DASHBOARD_NAME}」を作りました` : "届いた値を、目盛り付きのグラフにします"}
            />
          )}
        </StepRow>

        <StepRow number={4} state={rowState(4, step)} last>
          {step === 4 ? (
            <>
              <StepTitle state="current" title="完了" detail="センサー登録から計器盤の表示まで、一通り体験できました。" />
              <button type="button" onClick={() => setView("settings")} className="mt-2 text-sm text-blue-600 hover:underline">
                本物の機器をつなぐ方法へ
              </button>
            </>
          ) : (
            <StepTitle state="todo" title="完了" detail="本物の機器をつなぐ方法へ" />
          )}
        </StepRow>
      </ol>

      <div className="flex items-center gap-2.5 border-t pt-4" style={{ borderColor: "var(--fe-line)" }}>
        {step < 4 && (
          <button type="button" onClick={() => setView("main")} className="h-[34px] rounded border border-gray-300 bg-white px-3.5 text-sm text-gray-700 hover:bg-gray-50">
            あとで続ける
          </button>
        )}
        {step >= 2 && (
          <button type="button" onClick={restart} className="text-xs text-gray-500 hover:text-gray-700 hover:underline">
            最初からやり直す
          </button>
        )}
        <span className="flex-1" />
        {step === 1 && (
          <button type="submit" form={REGISTER_FORM_ID} disabled={createSensorMutation.isPending} className={PRIMARY_BUTTON_CLASS}>
            次へ
          </button>
        )}
        {step === 2 && (
          <button type="button" disabled className={PRIMARY_BUTTON_CLASS}>
            次へ（値が届いたら押せます）
          </button>
        )}
        {step === 3 && (
          <button type="button" onClick={() => createDashboardMutation.mutate()} disabled={createDashboardMutation.isPending || sensorGone} className={PRIMARY_BUTTON_CLASS}>
            計器盤を作る
          </button>
        )}
        {step === 4 && (
          <button
            type="button"
            onClick={() => {
              if (!dashboardId) return;
              // 最後まで終わったので、覚えた進み具合は消す（次に開いたときは、最初から）
              clearSetupProgress();
              selectDashboard(dashboardId);
            }}
            disabled={dashboardGone}
            className={PRIMARY_BUTTON_CLASS}
          >
            ダッシュボードを見る
          </button>
        )}
      </div>
    </div>
  );
}
