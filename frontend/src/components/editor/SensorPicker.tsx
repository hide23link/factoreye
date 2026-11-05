/**
 * 登録済みのセンサーから選ぶ画面（設定パネルの「＋ センサーを追加」で開く）。
 * 検索・種類の絞り込みができ、各行に状態の点・現在値・小さな推移線を出す（センサー棚と同じ見た目）。
 * 選んでいるセンサーには ✓ を付ける。複数選べるとき（グラフ）は、行をもう一度押すと外れる。
 *
 * 【誰が使うか】SensorField。
 * 【引数（props）】sensors = 登録済みのセンサー、selectedIds = 選択中の ID、suited = おすすめの種類（先頭に並べて印を付ける）、
 * multiple = 複数選べるか、onToggle = 行を押したとき（選択中なら外す／そうでなければ選ぶ）、onClose = 閉じる（「完了」ボタン）。
 * Esc で閉じる処理は、フォーカスの位置によらず効くよう、外側の SensorField にある。
 */
import { useEffect, useRef, useState } from "react";

import { useInView } from "../../hooks/useInView";
import { useSensorSnapshot } from "../../hooks/useSensorSnapshot";
import { SENSOR_KIND_LABEL, guessSensorKind, type SensorKind } from "../../lib/sensor-kind";
import type { Sensor } from "../../types";
import { Sparkline } from "./Sparkline";

interface Props {
  sensors: Sensor[];
  selectedIds: string[];
  suited: SensorKind | null;
  multiple: boolean;
  onToggle: (sensor: Sensor, selected: boolean) => void;
  onClose: () => void;
}

const KIND_FILTERS: ReadonlyArray<{ value: "all" | SensorKind; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "measure", label: SENSOR_KIND_LABEL.measure },
  { value: "count", label: SENSOR_KIND_LABEL.count },
  { value: "state", label: SENSOR_KIND_LABEL.state },
];

export function SensorPicker({ sensors, selectedIds, suited, multiple, onToggle, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | SensorKind>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  // 開いたらすぐ検索できるようにする。ただしスマホ（指で操作）では、画面の大半を覆うキーボードが出てしまうので、しない
  useEffect(() => {
    if (!window.matchMedia?.("(pointer: coarse)").matches) searchRef.current?.focus();
  }, []);

  // 削除済みのセンサーの ID は数えない
  const selectedCount = sensors.filter((s) => selectedIds.includes(s.id)).length;
  // 「おすすめ」は、おすすめの種類とそうでない種類が混ざっているときだけ付ける（全部が同じ種類なら、全行に付いて目障りなだけ）
  const mixedKinds = suited !== null && sensors.some((s) => guessSensorKind(s) !== suited);
  const needle = query.trim().toLowerCase();
  const visible = sensors
    .filter(
      (s) =>
        (filter === "all" || guessSensorKind(s) === filter) &&
        (needle === "" || `${s.name} ${s.ingestKey}`.toLowerCase().includes(needle)),
    )
    // おすすめの種類を先に並べる（同じ並びのときは元の順を保つ）
    .sort((a, b) => Number(guessSensorKind(b) === suited) - Number(guessSensorKind(a) === suited));

  return (
    // 閉じる操作（Esc）は、押した場所によらず効くよう、外側の SensorField が受ける。
    // role="dialog" にしないのは、DashboardView が「dialog がある間は編集のキー操作を止める」仕組みと取り違えないため
    <div
      role="group"
      aria-label="センサーを選ぶ"
      className="flex flex-col gap-2 rounded-lg border-2 border-blue-600 bg-white p-2"
    >
      <input
        ref={searchRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="センサーを検索"
        placeholder="🔍 名前やキーで探す"
        className="rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
      />
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
      <ul className="flex max-h-72 flex-col gap-1 overflow-auto">
        {visible.map((sensor) => (
          <PickerRow
            key={sensor.id}
            sensor={sensor}
            selected={selectedIds.includes(sensor.id)}
            recommended={mixedKinds && guessSensorKind(sensor) === suited}
            multiple={multiple}
            onToggle={onToggle}
          />
        ))}
        {visible.length === 0 && (
          <li className="py-3 text-center text-sm text-gray-500">
            {sensors.length === 0 ? "センサーがまだありません。設定画面から登録してください。" : "該当するセンサーがありません"}
          </li>
        )}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gray-500">{multiple ? `${selectedCount} 件を表示中` : ""}</span>
        <button type="button" onClick={onClose} className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700">
          {multiple ? "完了" : "閉じる"}
        </button>
      </div>
    </div>
  );
}

function PickerRow({
  sensor,
  selected,
  recommended,
  multiple,
  onToggle,
}: {
  sensor: Sensor;
  selected: boolean;
  recommended: boolean;
  multiple: boolean;
  onToggle: (sensor: Sensor, selected: boolean) => void;
}) {
  // 見えている行だけ取得する（センサーが多くても、全行を取りに行かない）
  const { ref, inView } = useInView<HTMLLIElement>();
  const { kind, shown, dotClass, series } = useSensorSnapshot(sensor, inView);

  return (
    <li ref={ref}>
      <button
        type="button"
        aria-pressed={multiple ? selected : undefined}
        aria-current={!multiple && selected ? "true" : undefined}
        onClick={() => onToggle(sensor, selected)}
        className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left hover:border-blue-500 ${
          selected ? "border-blue-600 bg-blue-50" : "border-gray-200 bg-white"
        }`}
      >
        {/* 選択中は ✓ で示す（色だけに頼らない）。1つだけ選ぶときは、今の選択に「選択中」の印を付ける */}
        {multiple ? (
          <span
            aria-hidden="true"
            className={`grid h-5 w-5 shrink-0 place-items-center rounded border-2 text-xs font-black text-white ${
              selected ? "border-blue-600 bg-blue-600" : "border-gray-300"
            }`}
          >
            {selected ? "✓" : ""}
          </span>
        ) : (
          selected && <span className="shrink-0 rounded-full bg-blue-600 px-1.5 text-[11px] text-white">選択中</span>
        )}
        <i aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 break-words text-sm font-semibold leading-tight">{sensor.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500">
            <span className="truncate">{SENSOR_KIND_LABEL[kind]}</span>
            {recommended && <span className="shrink-0 rounded-full bg-blue-100 px-1.5 text-blue-700">おすすめ</span>}
          </div>
        </div>
        {kind !== "state" && <Sparkline values={series} />}
        <span className="whitespace-nowrap text-right text-sm font-bold">
          {shown}
          {kind !== "state" && sensor.unit && <small className="ml-0.5 font-normal text-gray-500">{sensor.unit}</small>}
        </span>
      </button>
    </li>
  );
}
