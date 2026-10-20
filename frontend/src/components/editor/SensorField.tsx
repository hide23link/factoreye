/**
 * 設定パネルの「センサー」欄。選んだセンサーのチップ、ドラッグで入れる枠、「一覧から選ぶ」。
 *
 * - グラフ（複数OK）: チップの色の丸をクリックすると線の色が変わる。×で外す。ドロップは「追加」
 * - ほかの種類（1つ）: ドロップは「入れ替え」
 * ドラッグ以外でも選べるよう、「一覧から選ぶ」を必ず用意する（キーボード操作のため）。
 *
 * 【誰が使うか】GraphSettings、StatValueSettings、ProductionStatusSettings、ProductionPlanSettings。
 */
import { useState } from "react";

import { useSensors } from "../../hooks/queries";
import { SENSOR_KIND_LABEL, guessSensorKind, type SensorKind } from "../../lib/sensor-kind";
import { useEditorStore } from "../../store/useEditorStore";
import type { Sensor } from "../../types";

interface Props {
  sensorIds: string[];
  /** 複数のセンサーを持てるか（グラフ） */
  multiple: boolean;
  /** 候補の先頭に出す種類（案内。ほかの種類も選べる） */
  suited: SensorKind | null;
  /** 線の色（複数のときだけ。チップの丸に使う） */
  colorOf?: (index: number) => string;
  onRecolor?: (index: number) => void;
  onAdd: (sensor: Sensor) => void;
  onReplace: (sensor: Sensor) => void;
  onRemove: (index: number) => void;
}

export function SensorField({ sensorIds, multiple, suited, colorOf, onRecolor, onAdd, onReplace, onRemove }: Props) {
  const { data: sensors } = useSensors();
  const dragging = useEditorStore((s) => s.dragging);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [over, setOver] = useState(false);

  const nameOf = (id: string) => sensors?.find((s) => s.id === id)?.name ?? id;
  const candidates = (sensors ?? [])
    .filter((s) => multiple ? !sensorIds.includes(s.id) : true)
    // 向いている種類を先に並べる
    .sort((a, b) => Number(guessSensorKind(b) === suited) - Number(guessSensorKind(a) === suited));

  const accept = (sensor: Sensor) => (multiple ? onAdd(sensor) : onReplace(sensor));

  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="sensor-dropzone"
        onDragOver={(e) => {
          if (dragging?.kind !== "sensor") return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          if (dragging?.kind !== "sensor") return;
          e.preventDefault();
          const sensor = sensors?.find((s) => s.id === dragging.sensorId);
          if (sensor) accept(sensor);
        }}
        className={`flex flex-col gap-1.5 rounded-lg border-2 border-dashed p-2 ${
          over ? "border-blue-600 bg-blue-50" : "border-gray-200"
        }`}
      >
        <ul className="flex flex-wrap gap-1.5 empty:hidden">
          {sensorIds.map((id, index) => (
            <li key={id} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white py-0.5 pl-2 pr-1 text-sm">
              {multiple && colorOf && onRecolor && (
                <button
                  type="button"
                  aria-label={`${nameOf(id)}の線の色を変える`}
                  title="クリックで色を変更"
                  onClick={() => onRecolor(index)}
                  className="h-3 w-3 rounded-full ring-1 ring-gray-300"
                  style={{ backgroundColor: colorOf(index) }}
                />
              )}
              <span className="max-w-[9rem] truncate" title={nameOf(id)}>
                {nameOf(id)}
              </span>
              <button
                type="button"
                aria-label={`${nameOf(id)}を外す`}
                onClick={() => onRemove(index)}
                className="h-5 w-5 rounded-full text-gray-500 hover:bg-red-50 hover:text-red-600"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <p className="text-center text-xs text-gray-500">
          {sensorIds.length > 0 && !multiple ? "ドラッグで入れ替え" : "ここにドラッグ"}
        </p>
      </div>

      <button
        type="button"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen((open) => !open)}
        className="self-start rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
      >
        {pickerOpen ? "▲ 閉じる" : "▼ 一覧から選ぶ"}
      </button>
      {pickerOpen && (
        <ul className="max-h-48 overflow-auto rounded-lg border border-gray-200 bg-white">
          {candidates.length === 0 && <li className="p-2 text-sm text-gray-500">選べるセンサーがありません</li>}
          {candidates.map((sensor) => (
            <li key={sensor.id}>
              <button
                type="button"
                onClick={() => {
                  accept(sensor);
                  setPickerOpen(false);
                }}
                className="flex w-full items-center gap-2 border-b border-gray-100 px-2.5 py-1.5 text-left text-sm last:border-b-0 hover:bg-blue-50"
              >
                <span className="min-w-0 flex-1 truncate" title={sensor.name}>
                  {sensor.name}
                </span>
                <small className="shrink-0 text-gray-500">{SENSOR_KIND_LABEL[guessSensorKind(sensor)]}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
