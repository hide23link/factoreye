/**
 * センサー棚の 1 行（センサー 1 つ分）。チェックボックス・状態の点・現在値・小さな推移線・追加ボタン。
 * 画面に見えている行だけ、値を取得する。props が変わらない行は描き直さない（多数の行を持つ棚が重くならないよう memo にしてある）。
 *
 * 【誰が使うか】ShelfGroup（機器ごと）、EditorShelf（一覧）。
 * 【引数（props）】sensor = 表示するセンサー、needle = 検索の文字（強調）、selected = チェック済みか、
 * onToggleSelect / onAdd / onAddAs = 操作（どのセンサーかは、引数で受け取る。呼ぶ側は同じ関数を渡し続けられる）。
 */
import { memo } from "react";

import { Highlight } from "./Highlight";
import { Sparkline } from "./Sparkline";
import { WidgetIcon } from "./WidgetIcon";

import { useInView } from "../../hooks/useInView";
import { useSensorSnapshot } from "../../hooks/useSensorSnapshot";
import { SENSOR_KIND_LABEL } from "../../lib/sensor-kind";
import { widgetChoicesFor, widgetLabel } from "../../lib/widget-catalog";
import { useEditorStore } from "../../store/useEditorStore";
import type { Sensor, WidgetType } from "../../types";

interface SensorRowProps {
  sensor: Sensor;
  needle: string;
  selected: boolean;
  onToggleSelect: (sensor: Sensor) => void;
  onAdd: (sensor: Sensor) => void;
  onAddAs: (sensor: Sensor, type: WidgetType) => void;
}

export const SensorRow = memo(function SensorRow({ sensor, needle, selected, onToggleSelect, onAdd, onAddAs }: SensorRowProps) {
  const setDragging = useEditorStore((s) => s.setDragging);
  // 画面に見えている行だけ取得する（センサーが多くても、全行を取りに行かない）
  const { ref, inView } = useInView<HTMLLIElement>();
  const { kind, shown, dotClass, series } = useSensorSnapshot(sensor, inView);

  return (
    <li
      ref={ref}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", sensor.name);
        e.dataTransfer.effectAllowed = "copy";
        setDragging({ kind: "sensor", sensorId: sensor.id });
      }}
      onDragEnd={() => setDragging(null)}
      className={`flex cursor-grab flex-col gap-1 rounded-lg border px-2 py-1.5 hover:border-blue-500 active:cursor-grabbing ${
        selected ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(sensor)}
          aria-label={`${sensor.name}を選ぶ`}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer"
        />
        <span aria-hidden="true" className="select-none text-xs tracking-tighter text-gray-400">
          ⋮⋮
        </span>
        <i aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} />
        {/* 名前は 1 行目に幅いっぱいで出し（長くても 2 行まで）、種類・推移線・値は 2 行目に並べる。名前が値に押されて切れないようにする */}
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 break-words text-sm font-semibold leading-tight" title={sensor.name}>
            <Highlight text={sensor.name} needle={needle} />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="min-w-0 shrink truncate text-[11px] text-gray-500">{SENSOR_KIND_LABEL[kind]}</span>
            {kind !== "state" && <Sparkline values={series} />}
            <span className="ml-auto whitespace-nowrap text-right text-sm font-bold">
              {shown}
              {kind !== "state" && sensor.unit && <small className="ml-0.5 font-normal text-gray-500">{sensor.unit}</small>}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onAdd(sensor)}
          aria-label={`${sensor.name}を追加`}
          title="おすすめの置き方で追加（選択中のグラフがあれば、そこへ重ねます）"
          className="h-6 w-6 shrink-0 rounded-md border border-gray-300 bg-gray-50 leading-none hover:border-blue-600 hover:bg-blue-600 hover:text-white"
        >
          ＋
        </button>
      </div>
      {/* 置き方を選んで置く（「＋」は、おすすめ=いちばん左で置く） */}
      <div className="flex flex-wrap gap-1 pl-5">
        {widgetChoicesFor(kind).map((type, index) => (
          <button
            key={type}
            type="button"
            onClick={() => onAddAs(sensor, type)}
            aria-label={`${sensor.name}を${widgetLabel(type)}として追加`}
            title={`${widgetLabel(type)}として置く${index === 0 ? "（おすすめ）" : ""}`}
            className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] hover:border-blue-600 hover:bg-blue-600 hover:text-white ${
              index === 0 ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 bg-gray-50 text-gray-600"
            }`}
          >
            <WidgetIcon type={type} size={12} />
            {widgetLabel(type)}
          </button>
        ))}
      </div>
    </li>
  );
});
