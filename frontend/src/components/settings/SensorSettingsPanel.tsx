import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useSensors } from "../../hooks/queries";
import { createSensor, deleteSensor, updateSensor } from "../../lib/api";
import type { Sensor } from "../../types";

type NumOrBlank = number | "";

function toThreshold(v: NumOrBlank): number | null {
  return v === "" ? null : v;
}

// よく使う単位のプリセット。<datalist>なので一覧から選ぶことも自由入力することもできる
const UNIT_PRESETS = ["°C", "%", "MPa", "kPa", "Pa", "V", "A", "W", "kWh", "rpm", "Hz", "mm", "L", "kg"];

// 新規センサー作成フォームのIngest Key初期値（空欄のままにしないための仮の提案値、編集も削除も自由）
function generateIngestKey(): string {
  return `sensor-${Date.now().toString(36)}`;
}

function SensorRow({ sensor }: { sensor: Sensor }) {
  const queryClient = useQueryClient();
  const [isEditing, setEditing] = useState(false);
  const [name, setName] = useState(sensor.name);
  const [unit, setUnit] = useState(sensor.unit);
  const [thresholdMin, setThresholdMin] = useState<NumOrBlank>(sensor.thresholdMin ?? "");
  const [thresholdMax, setThresholdMax] = useState<NumOrBlank>(sensor.thresholdMax ?? "");
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["sensors"] });

  const saveMutation = useMutation({
    mutationFn: () =>
      updateSensor(sensor.id, {
        name,
        unit,
        thresholdMin: toThreshold(thresholdMin),
        thresholdMax: toThreshold(thresholdMax),
      }),
    onSuccess: () => {
      void invalidate();
      setError(null);
      setEditing(false);
    },
    onError: (e: Error) =>
      setError(e.message.includes("409") ? "その名前は既に使われています。" : e.message),
  });

  const toggleEnabledMutation = useMutation({
    mutationFn: () => updateSensor(sensor.id, { enabled: !sensor.enabled }),
    onSuccess: () => {
      void invalidate();
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSensor(sensor.id),
    onSuccess: () => {
      void invalidate();
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const errorRow = error && (
    <tr className="border-b border-gray-100 bg-red-50">
      <td colSpan={7} className="px-2 py-1 text-xs text-red-600">
        {error}
      </td>
    </tr>
  );

  if (isEditing) {
    return (
      <>
        <tr className="border-b border-gray-100 bg-blue-50/40">
          <td className="p-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </td>
          <td className="p-2 text-sm text-gray-400">{sensor.ingestKey}</td>
          <td className="p-2">
            <input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              list="unit-presets"
              className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </td>
          <td className="p-2">
            <input
              type="number"
              placeholder="なし"
              value={thresholdMin}
              onChange={(e) => setThresholdMin(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </td>
          <td className="p-2">
            <input
              type="number"
              placeholder="なし"
              value={thresholdMax}
              onChange={(e) => setThresholdMax(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </td>
          <td className="p-2 text-sm text-gray-400">{sensor.enabled ? "有効" : "無効"}</td>
          <td className="p-2 text-right">
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="mr-2 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
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
      <tr className="border-b border-gray-100">
        <td className="p-2 text-sm font-medium text-gray-900">{sensor.name}</td>
        <td className="p-2 font-mono text-xs text-gray-400">{sensor.ingestKey}</td>
        <td className="p-2 text-sm text-gray-600">{sensor.unit}</td>
        <td className="p-2 text-sm text-gray-600">{sensor.thresholdMin ?? "—"}</td>
        <td className="p-2 text-sm text-gray-600">{sensor.thresholdMax ?? "—"}</td>
        <td className="p-2 text-sm">
          <button
            type="button"
            onClick={() => toggleEnabledMutation.mutate()}
            disabled={toggleEnabledMutation.isPending}
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
            onClick={() => {
              if (
                confirm(
                  `センサー「${sensor.name}」を削除しますか？\n` +
                    "測定値・アラーム履歴も完全に削除されます。元に戻せません。",
                )
              ) {
                deleteMutation.mutate();
              }
            }}
            className="text-red-400 hover:text-red-600"
          >
            削除
          </button>
        </td>
      </tr>
      {errorRow}
    </>
  );
}

export function SensorSettingsPanel() {
  const { data: sensors, isLoading } = useSensors();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [ingestKey, setIngestKey] = useState(generateIngestKey);
  const [unit, setUnit] = useState("°C");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => createSensor({ name, ingestKey, unit }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sensors"] });
      setName("");
      // 空欄に戻すと次の入力がまた手探りになるため、次回分の仮キーを提案し直す
      setIngestKey(generateIngestKey());
      setUnit("°C");
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div>
      <h2 className="mb-3 text-lg font-bold text-gray-900">センサー管理</h2>

      <form
        className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && ingestKey.trim() && unit.trim()) createMutation.mutate();
        }}
      >
        <label className="text-sm">
          名前
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="圧力計A-1"
            className="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-sm">
          Ingest Key
          <input
            value={ingestKey}
            onChange={(e) => setIngestKey(e.target.value)}
            className="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-sm">
          単位
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            list="unit-presets"
            className="mt-1 block w-20 rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={createMutation.isPending}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          追加
        </button>
      </form>
      <datalist id="unit-presets">
        {UNIT_PRESETS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {isLoading && <p className="text-sm text-gray-400">読み込み中...</p>}

      {!isLoading && sensors && sensors.length > 0 && (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500">
              <th className="p-2">名前</th>
              <th className="p-2">Ingest Key</th>
              <th className="p-2">単位</th>
              <th className="p-2">下限</th>
              <th className="p-2">上限</th>
              <th className="p-2">状態</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {sensors.map((sensor) => (
              <SensorRow key={sensor.id} sensor={sensor} />
            ))}
          </tbody>
        </table>
      )}

      {!isLoading && sensors?.length === 0 && (
        <p className="text-sm text-gray-400">まだセンサーが登録されていません。</p>
      )}
    </div>
  );
}
