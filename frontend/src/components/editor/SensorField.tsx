/**
 * 設定パネルの「センサー」欄。選んだセンサーのチップ、ドラッグで入れる枠、「センサーを追加」（登録済みのセンサーを、状態・現在値つきで選ぶ）。
 *
 * - グラフ（複数OK）: チップの色の丸をクリックすると線の色が変わる。×で外す。ドロップは「追加」
 * - ほかの種類（1つ）: ドロップは「入れ替え」
 * ドラッグ以外でも選べるよう、「＋ センサーを追加」（SensorPicker）を必ず用意する（キーボード操作のため）。
 *
 * 【誰が使うか】GraphSettings、StatValueSettings、ProductionStatusSettings、ProductionPlanSettings、TargetStripSettings。
 */
import { useRef, useState } from "react";

import { useSensors } from "../../hooks/queries";
import type { SensorKind } from "../../lib/sensor-kind";
import { useEditorStore } from "../../store/useEditorStore";
import type { Sensor } from "../../types";
import { SensorPicker } from "./SensorPicker";

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
  const toggleRef = useRef<HTMLButtonElement>(null);
  // 閉じたら、開いたボタンにフォーカスを戻す（行や入力欄が消えて、フォーカスが失われないように）
  const closePicker = () => {
    setPickerOpen(false);
    toggleRef.current?.focus();
  };

  const nameOf = (id: string) => sensors?.find((s) => s.id === id)?.name ?? id;
  const accept = (sensor: Sensor) => (multiple ? onAdd(sensor) : onReplace(sensor));

  return (
    // data-sensor-field: DashboardView が、この中のキー操作（Delete・Ctrl+Z）を画面のウィジェットに効かせないための目印
    <div
      data-sensor-field
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape" && pickerOpen) {
          e.stopPropagation();
          closePicker();
        }
      }}
    >
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
        ref={toggleRef}
        type="button"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen((open) => !open)}
        className="self-start rounded-md border-2 border-dashed border-blue-600 bg-blue-50 px-3 py-1.5 text-sm font-bold text-blue-700 hover:bg-blue-100"
      >
        {pickerOpen ? "▲ 閉じる" : multiple ? "＋ センサーを追加" : "＋ センサーを選ぶ"}
      </button>
      {pickerOpen && (
        <SensorPicker
          sensors={sensors ?? []}
          selectedIds={sensorIds}
          suited={suited}
          multiple={multiple}
          onToggle={(sensor, selected) => {
            if (selected) {
              // 外せるのは複数選べるとき（グラフ）だけ。1つだけのときは、同じセンサーを押しても何も変えない
              const index = sensorIds.indexOf(sensor.id);
              if (multiple && index >= 0) onRemove(index);
            } else {
              accept(sensor);
            }
            if (!multiple) closePicker();
          }}
          onClose={closePicker}
        />
      )}
    </div>
  );
}
