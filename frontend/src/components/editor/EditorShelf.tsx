/**
 * 編集モードの左のセンサー棚。検索と種類の絞り込み。ステータスの点・現在値・小さな推移線つき。
 * 画面にドラッグするか、行の「＋」ボタンで追加できる（ドラッグできない人・操作のための「＋」）。
 * ウィジェットの種類は、別の窓（WidgetPalette）に分けてある。
 *
 * 【誰が使うか】DashboardView（編集モードのとき）。
 * 【引数（props）】dashboard = 編集中のダッシュボード。
 */
import { useState } from "react";

import { InfoButton } from "./controls";
import { Sparkline } from "./Sparkline";

import { useSensors } from "../../hooks/queries";
import { useInView } from "../../hooks/useInView";
import { useSensorSnapshot } from "../../hooks/useSensorSnapshot";
import { useMovableWindow } from "../../hooks/useMovableWindow";
import { useWidgetActions } from "../../hooks/useWidgetActions";
import { SENSOR_KIND_LABEL, guessSensorKind, type SensorKind } from "../../lib/sensor-kind";
import { useEditorStore } from "../../store/useEditorStore";
import type { DashboardDetail, Sensor } from "../../types";

/**
 * センサー棚（センサーだけ。ウィジェットの種類は WidgetPalette に分けた）。
 * 見出しをつかんで、画面内の好きな位置へ動かせる（矢印キーでも動かせる）。位置は保存され、「位置をもとに戻す」で既定の場所に戻る。
 * 狭い画面（640px 未満）は、従来どおり下寄せの固定で、動かせない。動かす仕組みは設定パネルと共通（useMovableWindow）。
 */
export function EditorShelf({ dashboard }: { dashboard: DashboardDetail }) {
  const setShelfOpen = useEditorStore((s) => s.setShelfOpen);
  const { handleProps, resetButton } = useMovableWindow("shelf", "センサー棚");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        {...handleProps}
        className="flex cursor-grab touch-none select-none items-center justify-between gap-1 border-b border-gray-200 px-3 py-2.5 active:cursor-grabbing"
      >
        <h2 className="text-sm font-bold">
          <span aria-hidden="true" className="mr-1.5 text-gray-400">
            ⋮⋮
          </span>
          センサー
        </h2>
        <div className="flex items-center gap-1">
          {resetButton}
          <button
            type="button"
            aria-label="センサー棚を閉じる"
            onClick={() => setShelfOpen(false)}
            className="h-6 w-6 rounded text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-auto p-2.5">
        <SensorShelf dashboard={dashboard} />
      </div>
    </div>
  );
}

const KIND_FILTERS: ReadonlyArray<{ value: "all" | SensorKind; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "measure", label: SENSOR_KIND_LABEL.measure },
  { value: "count", label: SENSOR_KIND_LABEL.count },
  { value: "state", label: SENSOR_KIND_LABEL.state },
];

function SensorShelf({ dashboard }: { dashboard: DashboardDetail }) {
  const { data: sensors, isError } = useSensors();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | SensorKind>("all");
  const [helpOpen, setHelpOpen] = useState(false);
  const actions = useWidgetActions(dashboard);

  const needle = query.trim().toLowerCase();
  const visible = (sensors ?? []).filter(
    (s) =>
      (filter === "all" || guessSensorKind(s) === filter) &&
      (needle === "" || `${s.name} ${s.ingestKey}`.toLowerCase().includes(needle)),
  );

  return (
    <>
      <div className="flex items-center gap-1.5">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="センサーを検索"
          placeholder="🔍 検索"
          title="センサーを検索（例: 温度、ライン1）"
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
        />
        <InfoButton label="センサー棚" open={helpOpen} onToggle={() => setHelpOpen((o) => !o)} />
      </div>
      {helpOpen && (
        <p className="rounded-md bg-blue-50 px-2.5 py-2 text-xs text-gray-600">
          センサーをドラッグして、グラフや空きスペースに<b>ドロップ</b>。または <b>＋</b> を押すだけでも追加できます。
        </p>
      )}
      <div role="group" aria-label="センサーの種類で絞り込む" className="flex flex-wrap gap-1.5">
        {KIND_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              filter === f.value ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300 bg-white text-gray-700"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ul className="flex flex-col gap-1.5">
        {visible.map((sensor) => (
          <SensorRow key={sensor.id} sensor={sensor} onAdd={() => void actions.addSensor(sensor)} />
        ))}
      </ul>
      {isError && <p className="text-xs text-red-600">センサーを取得できませんでした。</p>}
      {sensors && visible.length === 0 && (
        <p className="py-3 text-center text-sm text-gray-500">
          {sensors.length === 0 ? "センサーがまだありません。設定画面から登録してください。" : "該当するセンサーがありません"}
        </p>
      )}
    </>
  );
}

function SensorRow({ sensor, onAdd }: { sensor: Sensor; onAdd: () => void }) {
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
      className="flex cursor-grab items-center gap-2 rounded-lg border border-gray-200 bg-white px-2 py-1.5 hover:border-blue-500 active:cursor-grabbing"
    >
      <span aria-hidden="true" className="select-none text-xs tracking-tighter text-gray-400">
        ⋮⋮
      </span>
      <i aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} />
      {/* 名前は 1 行目に幅いっぱいで出し（長くても 2 行まで）、種類・推移線・値は 2 行目に並べる。名前が値に押されて切れないようにする */}
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 break-words text-sm font-semibold leading-tight" title={sensor.name}>{sensor.name}</div>
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
        onClick={onAdd}
        aria-label={`${sensor.name}を追加`}
        title="追加"
        className="h-6 w-6 shrink-0 rounded-md border border-gray-300 bg-gray-50 leading-none hover:border-blue-600 hover:bg-blue-600 hover:text-white"
      >
        ＋
      </button>
    </li>
  );
}
