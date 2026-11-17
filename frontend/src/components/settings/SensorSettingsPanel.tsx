/**
 * センサーの管理パネル。一覧（編集・有効/無効・削除）と、新規登録のフォームを持つ。
 *
 * 閾値（しきい値）は空欄なら「なし」（判定しない）。Free Tier の上限に達すると、案内を出す。
 *
 * 【誰が使うか】SettingsPage.tsx が、選んだタブのときだけ出す。引数（props）はない。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type ReactNode } from "react";

import { useLatestReadings, useSensors } from "../../hooks/queries";
import { useNow } from "../../hooks/useNow";
import { createSensor, deleteSensor, updateSensor } from "../../lib/api";
import { describeActionError, describeSensorError } from "../../lib/errors";
import { FREE_TIER_LIMIT_MESSAGE, isFreeTierLimitError } from "../../lib/freeTier";
import { isImeComposing } from "../../lib/ime";
import { formatAge } from "../../lib/overview";
import { filterCounts, groupByDevice, matchesFilter, matchesQuery, sensorLive, type ListFilter, type SensorLive } from "../../lib/sensor-list";
import { validateSensorBasics, validateThresholds } from "../../lib/sensor-validation";
import type { Sensor, Widget } from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorNotice } from "../ErrorNotice";
import { TrendStackWidget } from "../widgets/TrendStackWidget";
import { UnitSelect } from "../UnitSelect";
import { SensorConnectGuide } from "./SensorConnectGuide";
import { ThresholdBar } from "./ThresholdBar";

// 入力欄の値。数値、または空欄（""）。空欄は「しきい値なし」を表す
type NumOrBlank = number | "";

/** 入力欄の値を、API に送る形（空欄は null）にする。 */
function toThreshold(v: NumOrBlank): number | null {
  return v === "" ? null : v;
}

/** しきい値の数値入力欄（空欄可）。 */
function thresholdInput(
  value: NumOrBlank,
  onChange: (v: NumOrBlank) => void,
  label: string,
  placeholder = "なし",
) {
  return (
    <input
      type="number"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
      className="w-20 rounded border border-gray-300 px-1.5 py-1 text-sm"
    />
  );
}

// 新規センサー作成フォームのIngest Key初期値（空欄のままにしないための仮の提案値、編集も削除も自由）
/** 取り込みキーの仮の値（sensor-＋現在時刻の36進）。重複しにくいように時刻を使う。 */
function generateIngestKey(): string {
  return `sensor-${Date.now().toString(36)}`;
}

/** 「種類から始める」の選択肢。選ぶと単位の初期値が入る（計測値は °C、生産数は個、稼働は 0/1。単位は選んだあとで変えられる）。選ばなくても登録できる */
type SensorStartKind = "measure" | "count" | "state";
const SENSOR_START_KINDS: ReadonlyArray<{ id: SensorStartKind; icon: string; label: string; hint: string; unit: string }> = [
  { id: "measure", icon: "🌡️", label: "計測値", hint: "温度・圧力・振動など", unit: "°C" },
  { id: "count", icon: "📦", label: "生産数", hint: "できた個数を数える", unit: "個" },
  { id: "state", icon: "🚦", label: "稼働", hint: "動いている=1、止まっている=0", unit: "0/1" },
];

// 絞り込みのボタン（名前と、条件。条件は lib/sensor-list.ts の matchesFilter）
const FILTERS: ReadonlyArray<{ value: ListFilter; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "receiving", label: "受信中" },
  { value: "stopped", label: "止まっている" },
  { value: "limits", label: "しきい値あり" },
];

/** 名前の下に出す、今の値・受信の状態・最後の受信（操作室の計器の表示と同じ色づかい） */
function LiveLine({ live, unit }: { live: SensorLive; unit: string }) {
  const colors = { receiving: "var(--fe-ok)", stopped: "var(--fe-amb)", never: "var(--fe-mut)" } as const;
  const text = { receiving: "受信中", stopped: "止まっている", never: "未受信" } as const;
  const valueColor = live.level === "critical" ? "var(--fe-red)" : live.level === "warning" ? "var(--fe-amb)" : undefined;
  return (
    <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-num text-[11px] font-normal text-gray-600">
      <span style={{ color: colors[live.state] }} className="font-bold">
        {live.state === "receiving" ? "■" : live.state === "stopped" ? "●" : "○"} {text[live.state]}
      </span>
      {live.latest && (
        <span style={{ color: valueColor }} className={live.level === "normal" ? "text-gray-900" : "font-bold"}>
          {Math.abs(live.latest.value) >= 100 ? Math.round(live.latest.value) : Number(live.latest.value.toFixed(2))} {unit}
        </span>
      )}
      {live.ageMs !== null && <span>{formatAge(live.ageMs)}</span>}
      {live.state === "never" && <span>まだ受信なし</span>}
    </span>
  );
}

/** 詳細パネル（名前を押したセンサー）。24 時間の計器グラフ（目盛り・最高・最低・平均・しきい値）と、設定の要約 */
function SensorDetail({ sensor, live, onClose }: { sensor: Sensor; live?: SensorLive; onClose: () => void }) {
  // 計器グラフの部品を、1 センサー・24 時間の設定で使う（ダッシュボードの期間とは別）
  const widget: Widget = {
    id: `detail-${sensor.id}`,
    dashboardId: "",
    sensorId: sensor.id,
    type: "TrendStack",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 12,
    gridHeight: 8,
    config: { sensorIds: [sensor.id], rangeHours: 24 },
    createdAt: "",
    updatedAt: "",
  };
  return (
    <aside aria-label={`${sensor.name} の詳細`} className="flex min-w-0 flex-col gap-2 rounded border border-gray-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-gray-900">{sensor.name}</h3>
          <p className="font-num text-[11px] text-gray-500">
            {sensor.deviceName ? `${sensor.deviceName} · ` : ""}
            {sensor.ingestKey}
          </p>
          {live && <LiveLine live={live} unit={sensor.unit} />}
        </div>
        <button type="button" onClick={onClose} aria-label="詳細を閉じる" className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100">
          閉じる
        </button>
      </div>
      <div className="h-44 rounded-sm border border-gray-200">
        <TrendStackWidget widget={widget} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-num text-xs">
        <dt className="text-gray-600">軽故障（下限 / 上限）</dt>
        <dd>
          {sensor.thresholdMinWarning ?? "—"} / {sensor.thresholdMaxWarning ?? "—"} {sensor.unit}
        </dd>
        <dt className="text-gray-500">重故障（下限 / 上限）</dt>
        <dd>
          {sensor.thresholdMinCritical ?? "—"} / {sensor.thresholdMaxCritical ?? "—"} {sensor.unit}
        </dd>
        <dt className="text-gray-500">不感帯</dt>
        <dd>{sensor.thresholdDeadBand}</dd>
      </dl>
      <p className="text-xs text-gray-500">しきい値や名前は、一覧の「編集」で変えます。</p>
    </aside>
  );
}

/**
 * センサー1件の行。表示と編集を切り替える（編集中は、名前・単位・閾値を入力欄にする）。
 * 保存・有効/無効・削除の操作ごとに、一覧を取り直す。
 */
function SensorRow({
  sensor,
  live,
  selected,
  detail,
  onSelect,
  onDeleted,
}: {
  sensor: Sensor;
  // 受信の状態（今の値・最後の受信）。取れていないときは undefined
  live?: SensorLive;
  selected?: boolean;
  // 選んだ行のすぐ下に開く詳細（SensorDetail）。選んでいなければ undefined
  detail?: ReactNode;
  onSelect?: (sensorId: string) => void;
  onDeleted: (sensorId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [isEditing, setEditing] = useState(false);
  const [name, setName] = useState(sensor.name);
  const [unit, setUnit] = useState(sensor.unit);
  const [minWarning, setMinWarning] = useState<NumOrBlank>(sensor.thresholdMinWarning ?? "");
  const [minCritical, setMinCritical] = useState<NumOrBlank>(sensor.thresholdMinCritical ?? "");
  const [maxWarning, setMaxWarning] = useState<NumOrBlank>(sensor.thresholdMaxWarning ?? "");
  const [maxCritical, setMaxCritical] = useState<NumOrBlank>(sensor.thresholdMaxCritical ?? "");
  const [deadBand, setDeadBand] = useState<NumOrBlank>(sensor.thresholdDeadBand);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["sensors"] });

  // 編集をやめるとき、入力途中の値を元の値に戻す（次に編集を開いたとき、前回の途中の値が残らないように）
  const cancelEdit = () => {
    setName(sensor.name);
    setUnit(sensor.unit);
    setMinWarning(sensor.thresholdMinWarning ?? "");
    setMinCritical(sensor.thresholdMinCritical ?? "");
    setMaxWarning(sensor.thresholdMaxWarning ?? "");
    setMaxCritical(sensor.thresholdMaxCritical ?? "");
    setDeadBand(sensor.thresholdDeadBand);
    setError(null);
    setEditing(false);
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      updateSensor(sensor.id, {
        // 前後の空白は送らない（見た目では同じ名前が、別の名前として登録されるのを防ぐ）
        name: name.trim(),
        unit: unit.trim(),
        thresholdMinWarning: toThreshold(minWarning),
        thresholdMinCritical: toThreshold(minCritical),
        thresholdMaxWarning: toThreshold(maxWarning),
        thresholdMaxCritical: toThreshold(maxCritical),
        thresholdDeadBand: deadBand === "" ? 0 : deadBand,
      }),
    onSuccess: () => {
      void invalidate();
      setError(null);
      setEditing(false);
    },
    onError: (e: Error) => setError(describeSensorError(e, "センサーの保存")),
  });

  // 保存の前に、入力を確かめる（空の名前・単位、しきい値の大小の逆転）。サーバーの 422 を待たずに、日本語で理由を出す
  const trySave = () => {
    const problem =
      validateSensorBasics({ name, unit }) ??
      validateThresholds({
        minCritical: toThreshold(minCritical),
        minWarning: toThreshold(minWarning),
        maxWarning: toThreshold(maxWarning),
        maxCritical: toThreshold(maxCritical),
      });
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    saveMutation.mutate();
  };

  const toggleEnabledMutation = useMutation({
    mutationFn: () => updateSensor(sensor.id, { enabled: !sensor.enabled }),
    onSuccess: () => {
      void invalidate();
      setError(null);
    },
    onError: (e: Error) => setError(describeActionError(e, "有効/無効の切り替え")),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSensor(sensor.id),
    onSuccess: () => {
      void invalidate();
      onDeleted(sensor.id);
      setError(null);
    },
    onError: (e: Error) => setError(describeActionError(e, "センサーの削除")),
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const errorRow = error && (
    <tr className="border-b border-gray-100 bg-red-50">
      <td colSpan={8} className="px-2 py-1 text-xs text-red-600">
        <div role="alert">{error}</div>
      </td>
    </tr>
  );

  if (isEditing) {
    return (
      <>
        <tr
          className="border-b border-gray-100 bg-blue-50/40"
          // 表の行はフォームにできないので、Enter で保存・Esc でキャンセルを、ここで受ける
          onKeyDown={(e) => {
            if (e.key === "Escape") cancelEdit();
            else if (e.key === "Enter" && !isImeComposing(e) && e.target instanceof HTMLInputElement) {
              e.preventDefault();
              trySave();
            }
          }}
        >
          <td className="p-2">
            <input
              aria-label="センサー名"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </td>
          <td className="p-2 text-sm text-gray-500">{sensor.ingestKey}</td>
          <td className="p-2">
            <UnitSelect value={unit} onChange={setUnit} />
          </td>
          <td className="p-2">
            <div className="flex items-center gap-1">
              {thresholdInput(minWarning, setMinWarning, "軽故障の下限")}
              <span className="text-gray-500">/</span>
              {thresholdInput(maxWarning, setMaxWarning, "軽故障の上限")}
            </div>
          </td>
          <td className="p-2">
            <div className="flex items-center gap-1">
              {thresholdInput(minCritical, setMinCritical, "重故障の下限")}
              <span className="text-gray-500">/</span>
              {thresholdInput(maxCritical, setMaxCritical, "重故障の上限")}
            </div>
          </td>
          <td className="p-2">
            <input
              type="number"
              aria-label="不感帯"
              min={0}
              value={deadBand}
              onChange={(event) => setDeadBand(event.target.value === "" ? "" : Number(event.target.value))}
              className="w-14 rounded border border-gray-300 px-1.5 py-1 text-sm"
            />
          </td>
          <td className="p-2 text-sm text-gray-500">{sensor.enabled ? "有効" : "無効"}</td>
          <td className="p-2 text-right">
            <button
              type="button"
              onClick={trySave}
              disabled={saveMutation.isPending}
              className="mr-2 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
            >
              キャンセル
            </button>
          </td>
        </tr>
        {errorRow}
      </>
    );
  }

  return (
    <>
      <tr className={`border-b border-gray-100 ${selected ? "bg-blue-50" : ""}`}>
        <td className="p-2 text-sm font-medium text-gray-900">
          {sensor.name}
          {onSelect && (
            <button
              type="button"
              onClick={() => onSelect(sensor.id)}
              aria-pressed={selected}
              aria-label={`${sensor.name} の詳細`}
              title="24 時間のグラフと詳細を、この行の下に出す"
              className="ml-2 rounded border border-gray-300 px-1.5 py-px text-[11px] font-normal text-gray-500 hover:bg-gray-100"
            >
              詳細
            </button>
          )}
          {live && <LiveLine live={live} unit={sensor.unit} />}
          <ThresholdBar sensor={sensor} />
        </td>
        <td className="p-2 font-mono text-xs text-gray-500">{sensor.ingestKey}</td>
        <td className="p-2 text-sm text-gray-600">{sensor.unit}</td>
        <td className="p-2 text-sm text-gray-600">
          {sensor.thresholdMinWarning ?? "—"} / {sensor.thresholdMaxWarning ?? "—"}
        </td>
        <td className="p-2 text-sm text-gray-600">
          {sensor.thresholdMinCritical ?? "—"} / {sensor.thresholdMaxCritical ?? "—"}
        </td>
        <td className="p-2 text-sm text-gray-600">{sensor.thresholdDeadBand}</td>
        <td className="p-2 text-sm">
          <button
            type="button"
            onClick={() => toggleEnabledMutation.mutate()}
            disabled={toggleEnabledMutation.isPending}
            aria-pressed={sensor.enabled}
            title={sensor.enabled ? "クリックで無効にする" : "クリックで有効にする"}
            className={
              sensor.enabled
                ? "rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700 hover:bg-green-200"
                : "rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-200"
            }
          >
            {sensor.enabled ? "有効" : "無効"}
          </button>
        </td>
        <td className="p-2 text-right text-xs">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="mr-3 text-gray-500 hover:text-blue-600"
          >
            編集
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="text-red-400 hover:text-red-600"
          >
            削除
          </button>
        </td>
      </tr>
      {detail && (
        <tr className="border-b border-gray-100 bg-blue-50/30">
          <td colSpan={8} className="p-2">
            {detail}
          </td>
        </tr>
      )}
      {errorRow}
      {confirmingDelete && (
        <tr>
          <td className="p-0">
            <ConfirmDialog
              title="センサーを削除"
              message={`センサー「${sensor.name}」を削除しますか？測定値・アラーム履歴も完全に削除されます。元に戻せません。`}
              pending={deleteMutation.isPending}
              onCancel={() => setConfirmingDelete(false)}
              onConfirm={() => {
                setConfirmingDelete(false);
                deleteMutation.mutate();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/** センサー設定パネル（新規登録フォームと、センサー一覧）。 */
export function SensorSettingsPanel() {
  const { data: sensors, isLoading, isError, refetch } = useSensors();
  // 一覧の受信の状態（今の値・最後の受信）に使う、全センサーの最新の測定値（1 回の取得）
  const { data: latestData } = useLatestReadings();
  const now = useNow(10_000);
  const queryClient = useQueryClient();
  // 検索の文字・絞り込みのボタン・詳細を出しているセンサー
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 新規登録フォームの入力値（登録に成功すると、次の入力のために初期値へ戻す）
  const [name, setName] = useState("");
  const [ingestKey, setIngestKey] = useState(generateIngestKey);
  const [unit, setUnit] = useState("°C");
  const [error, setError] = useState<string | null>(null);
  // 登録した直後のセンサー（つなぎ方の案内を出す）と、選んだ種類（単位の初期値のため）
  const [justCreated, setJustCreated] = useState<Sensor | null>(null);
  const [startKind, setStartKind] = useState<SensorStartKind | null>(null);

  // 新規登録。上限（Free Tier）に達した場合は、案内の文言を出す
  const createMutation = useMutation({
    mutationFn: () => createSensor({ name: name.trim(), ingestKey: ingestKey.trim(), unit: unit.trim() }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["sensors"] });
      setJustCreated(created);
      setStartKind(null);
      setName("");
      // 空欄に戻すと次の入力がまた手探りになるため、次回分の仮キーを提案し直す
      setIngestKey(generateIngestKey());
      setUnit("°C");
      setError(null);
    },
    onError: (e: Error) =>
      setError(isFreeTierLimitError(e) ? FREE_TIER_LIMIT_MESSAGE : describeSensorError(e, "センサーの登録")),
  });

  const latestBySensor = new Map((latestData?.readings ?? []).map((reading) => [reading.sensorId, reading]));
  const lives = new Map((sensors ?? []).map((sensor) => [sensor.id, sensorLive(sensor, latestBySensor.get(sensor.id), now)]));
  const counts = filterCounts(sensors ?? [], lives, query);
  const visible = (sensors ?? []).filter((sensor) => {
    const live = lives.get(sensor.id);
    return matchesQuery(sensor, query) && (live ? matchesFilter(filter, sensor, live) : true);
  });
  const groups = groupByDevice(visible);
  // 機器に属するセンサーがあるときだけ、機器ごとの見出しを出す（機器の無い SaaS 版などでは出さない）
  const showGroups = (sensors ?? []).some((sensor) => sensor.deviceId);

  return (
    <div>
      <h2 className="mb-3 text-lg font-bold text-gray-900">センサー管理</h2>

      {justCreated && <SensorConnectGuide key={justCreated.id} sensor={justCreated} onClose={() => setJustCreated(null)} />}

      <div role="group" aria-label="センサーの種類から始める" className="mb-2 flex flex-wrap gap-2">
        {SENSOR_START_KINDS.map((kind) => (
          <button
            key={kind.id}
            type="button"
            aria-pressed={startKind === kind.id}
            onClick={() => {
              setStartKind(kind.id);
              setUnit(kind.unit);
            }}
            title={kind.hint}
            className={`flex items-center gap-2 rounded-lg border-2 px-3 py-1.5 text-left text-sm ${
              startKind === kind.id ? "border-blue-600 bg-blue-50" : "border-gray-200 bg-white hover:border-blue-400"
            }`}
          >
            <span aria-hidden="true" className="text-xl">
              {kind.icon}
            </span>
            <span>
              <b className="block leading-tight">{kind.label}</b>
              <small className="text-gray-500">{kind.hint}</small>
            </span>
          </button>
        ))}
      </div>
      <form
        className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          // 空欄があるときは、黙って何もしないのではなく、理由を出す
          const problem = validateSensorBasics({ name, unit, ingestKey });
          setError(problem);
          if (!problem) createMutation.mutate();
        }}
      >
        <label className="text-sm">
          名前
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="圧力計A-1"
            className="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-sm">
          Ingest Key
          <input
            value={ingestKey}
            onChange={(event) => setIngestKey(event.target.value)}
            className="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-sm">
          単位
          <UnitSelect value={unit} onChange={setUnit} className="mt-1 flex" />
        </label>
        <button
          type="submit"
          disabled={createMutation.isPending}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          追加
        </button>
      </form>
      <p className="mb-3 text-xs text-gray-500">
        しきい値（軽故障・重故障・不感帯）は作成後、一覧の「編集」から設定します。
      </p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {error}
        </p>
      )}

      {isLoading && <p className="text-sm text-gray-500">読み込み中...</p>}

      {!isLoading && !sensors && isError && (
        <ErrorNotice message="センサーの一覧を取得できませんでした。" onRetry={() => void refetch()} />
      )}

      {!isLoading && sensors && sensors.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <label className="flex h-8 min-w-40 max-w-72 flex-1 items-center gap-1.5 rounded border border-gray-300 bg-white px-2 text-gray-500">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                aria-label="センサーを絞り込む"
                placeholder="名前・キー・機器で絞り込む"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none"
              />
            </label>
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
                className={`h-8 rounded border px-2.5 text-xs ${
                  filter === item.value ? "border-blue-600 bg-blue-50 font-bold text-blue-700" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-100"
                }`}
              >
                {item.label} <span className="font-num">{counts[item.value]}</span>
              </button>
            ))}
          </div>
          <div>
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th className="p-2">名前</th>
                    <th className="p-2">Ingest Key</th>
                    <th className="p-2">単位</th>
                    <th className="p-2">軽故障（下限/上限）</th>
                    <th className="p-2">重故障（下限/上限）</th>
                    <th className="p-2">不感帯</th>
                    <th className="p-2">状態</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <Fragment key={group.key}>
                      {showGroups && (
                        <tr className="bg-gray-100">
                          <td colSpan={8} className="px-2 py-1 text-[11px] font-bold tracking-wide text-gray-600">
                            {group.title}
                            {group.line ? ` · ${group.line}` : ""}
                            <span className="ml-2 font-num font-normal">{group.sensors.length} センサー</span>
                          </td>
                        </tr>
                      )}
                      {group.sensors.map((sensor) => (
                        <SensorRow
                          key={sensor.id}
                          sensor={sensor}
                          live={lives.get(sensor.id)}
                          selected={sensor.id === selectedId}
                          detail={sensor.id === selectedId ? <SensorDetail sensor={sensor} live={lives.get(sensor.id)} onClose={() => setSelectedId(null)} /> : undefined}
                          onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
                          // 削除したセンサーの「つなぎ方」の案内は、閉じる（削除済みのセンサーを待ち続けないように）
                          onDeleted={(id) => {
                            setJustCreated((current) => (current?.id === id ? null : current));
                            setSelectedId((current) => (current === id ? null : current));
                          }}
                        />
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {visible.length === 0 && <p className="py-3 text-sm text-gray-500">該当するセンサーはありません。</p>}
            </div>
          </div>
        </>
      )}

      {!isLoading && sensors?.length === 0 && (
        <p className="text-sm text-gray-500">まだセンサーが登録されていません。</p>
      )}
    </div>
  );
}
