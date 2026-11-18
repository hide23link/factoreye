/**
 * センサー一覧の右に出す詳細の欄（設定 › センサー）。一覧の行を押すと開く。
 *
 * 上から: 名前・機器・Ingest Key、今の値、24 時間の計器グラフ（目盛り・最高・最低・平均・しきい値）、
 * 設定の入力（表示名・単位・しきい値・不感帯）と、しきい値の色の帯、「保存」「取り消す」。
 * ふだん使わない操作（Ingest Key・有効/無効・削除）は「詳しい設定」にたたんでいる。
 *
 * 保存の前に入力を確かめる（空の名前・単位、しきい値の大小の逆転）。サーバーの 422 を待たずに、日本語で理由を出す。
 * キーボード: 名前・しきい値・不感帯の入力欄で Enter なら保存、Esc なら取り消す（日本語入力の変換確定の Enter は除く）。
 *
 * 【誰が使うか】SensorSettingsPanel。別のセンサーを選んだときは、呼ぶ側が key=センサーの id を付けて作り直す（入力途中の値を持ち越さない）。
 * 【引数（props）】sensor = 選んだセンサー、live = 受信の状態（取れていなければ undefined）、onClose = 閉じる、onDeleted = 削除したあとの後片付け。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";

import { deleteSensor, updateSensor } from "../../lib/api";
import { describeActionError, describeSensorError } from "../../lib/errors";
import { isImeComposing } from "../../lib/ime";
import { formatLiveValue, type SensorLive } from "../../lib/sensor-list";
import { validateSensorBasics, validateThresholds } from "../../lib/sensor-validation";
import type { Sensor, Widget } from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";
import { UnitSelect } from "../UnitSelect";
import { TrendStackWidget } from "../widgets/TrendStackWidget";
import { ThresholdBar } from "./ThresholdBar";

// 入力欄の値。数値、または空欄（""）。空欄は「しきい値なし」を表す
type NumOrBlank = number | "";

/** 入力欄の値を、API に送る形（空欄は null）にする。 */
function toThreshold(v: NumOrBlank): number | null {
  return v === "" ? null : v;
}

/** しきい値の数値入力欄（空欄可）。 */
function ThresholdInput({
  value,
  onChange,
  label,
  onKeyDown,
}: {
  value: NumOrBlank;
  onChange: (v: NumOrBlank) => void;
  label: string;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      type="number"
      aria-label={label}
      placeholder="なし"
      value={value}
      onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
      onKeyDown={onKeyDown}
      className="w-full min-w-0 rounded border border-gray-300 bg-white px-1.5 py-1 font-num text-sm text-gray-900"
    />
  );
}

/** 24 時間の計器グラフ。計器グラフの部品を、1 センサー・24 時間の設定で使う（ダッシュボードの期間とは別） */
function DetailChart({ sensor }: { sensor: Sensor }) {
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
    <div className="h-44 rounded-sm border border-gray-200">
      <TrendStackWidget widget={widget} />
    </div>
  );
}

export function SensorDetailPane({
  sensor,
  live,
  onClose,
  onDeleted,
}: {
  sensor: Sensor;
  live?: SensorLive;
  onClose: () => void;
  onDeleted: (sensorId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(sensor.name);
  const [unit, setUnit] = useState(sensor.unit);
  const [minWarning, setMinWarning] = useState<NumOrBlank>(sensor.thresholdMinWarning ?? "");
  const [minCritical, setMinCritical] = useState<NumOrBlank>(sensor.thresholdMinCritical ?? "");
  const [maxWarning, setMaxWarning] = useState<NumOrBlank>(sensor.thresholdMaxWarning ?? "");
  const [maxCritical, setMaxCritical] = useState<NumOrBlank>(sensor.thresholdMaxCritical ?? "");
  const [deadBand, setDeadBand] = useState<NumOrBlank>(sensor.thresholdDeadBand);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["sensors"] });

  // 取り消す: 入力途中の値を、保存してある値に戻す
  const reset = () => {
    setName(sensor.name);
    setUnit(sensor.unit);
    setMinWarning(sensor.thresholdMinWarning ?? "");
    setMinCritical(sensor.thresholdMinCritical ?? "");
    setMaxWarning(sensor.thresholdMaxWarning ?? "");
    setMaxCritical(sensor.thresholdMaxCritical ?? "");
    setDeadBand(sensor.thresholdDeadBand);
    setError(null);
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
    },
    onError: (e: Error) => setError(describeSensorError(e, "センサーの保存")),
  });

  // 保存の前に、入力を確かめる。問題があれば、理由を出して保存しない
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

  // 入力欄で Enter なら保存、Esc なら取り消す（日本語入力の変換確定の Enter では保存しない）
  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") reset();
    else if (e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault();
      trySave();
    }
  };

  const valueColor = live?.level === "critical" ? "var(--fe-red)" : live?.level === "warning" ? "var(--fe-amb)" : undefined;
  const stopped = live?.state !== "receiving";

  return (
    <aside
      aria-label={`${sensor.name} の詳細`}
      className="flex min-w-0 flex-col gap-3 rounded border border-gray-200 bg-white p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-gray-900">{sensor.name}</h3>
          <p className="truncate font-num text-[11px] text-gray-500">
            {sensor.deviceName ? `${sensor.deviceName} · ` : ""}
            {sensor.ingestKey}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="詳細を閉じる" className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100">
          閉じる
        </button>
      </div>

      {/* 今の値（止まっているときは「---」を橙で。最後の値は一覧に出ている） */}
      <div className="flex items-baseline gap-2">
        <span
          className="rounded-sm border-[1.5px] px-2 py-0.5 font-num text-2xl font-bold text-gray-900"
          style={{ borderColor: stopped ? "var(--fe-amb)" : (valueColor ?? "var(--fe-ink)"), color: stopped ? "var(--fe-amb)" : valueColor }}
        >
          {live?.latest && !stopped ? formatLiveValue(live.latest.value) : "---"}
        </span>
        <span className="font-num text-sm text-gray-500">{sensor.unit}</span>
      </div>

      <DetailChart sensor={sensor} />

      <div className="flex flex-col gap-2">
        <label className="text-xs text-gray-500">
          表示名
          <input
            aria-label="センサー名"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onInputKeyDown}
            className="mt-0.5 block w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900"
          />
        </label>
        <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-2 gap-y-1 text-xs text-gray-500">
          <span />
          <span>下限</span>
          <span>上限</span>
          <span>軽故障</span>
          <ThresholdInput value={minWarning} onChange={setMinWarning} label="軽故障の下限" onKeyDown={onInputKeyDown} />
          <ThresholdInput value={maxWarning} onChange={setMaxWarning} label="軽故障の上限" onKeyDown={onInputKeyDown} />
          <span>重故障</span>
          <ThresholdInput value={minCritical} onChange={setMinCritical} label="重故障の下限" onKeyDown={onInputKeyDown} />
          <ThresholdInput value={maxCritical} onChange={setMaxCritical} label="重故障の上限" onKeyDown={onInputKeyDown} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
          <label>
            不感帯
            <input
              type="number"
              aria-label="不感帯"
              min={0}
              value={deadBand}
              onChange={(event) => setDeadBand(event.target.value === "" ? "" : Number(event.target.value))}
              onKeyDown={onInputKeyDown}
              className="mt-0.5 block w-full rounded border border-gray-300 bg-white px-1.5 py-1 font-num text-sm text-gray-900"
            />
          </label>
          <div>
            単位
            <UnitSelect value={unit} onChange={setUnit} className="mt-0.5 flex" />
          </div>
        </div>
        <div>
          <span className="text-xs text-gray-500">しきい値の帯（今の保存内容）</span>
          <ThresholdBar sensor={sensor} />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={trySave}
          disabled={saveMutation.isPending}
          className="h-9 flex-1 rounded bg-blue-600 px-3 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          保存
        </button>
        <button type="button" onClick={reset} className="h-9 rounded border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-100">
          取り消す
        </button>
      </div>

      <details className="rounded border border-gray-200 text-sm">
        <summary className="cursor-pointer px-2 py-1.5 text-gray-600">詳しい設定</summary>
        <div className="flex flex-col gap-2 border-t border-gray-200 p-2">
          <p className="text-xs text-gray-500">
            Ingest Key <span className="ml-1 font-mono text-gray-900">{sensor.ingestKey}</span>
          </p>
          <div className="flex items-center gap-2">
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
            <button type="button" onClick={() => setConfirmingDelete(true)} className="ml-auto text-xs text-red-400 hover:text-red-600">
              削除
            </button>
          </div>
        </div>
      </details>

      {confirmingDelete && (
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
      )}
    </aside>
  );
}
