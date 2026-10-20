/**
 * 編集モードの左の棚。「センサー」と「ウィジェット」の2つのタブ。
 *
 * - センサー: 検索と種類の絞り込み。ステータスの点・現在値・小さな推移線つき。
 *   画面にドラッグするか、行の「＋」ボタンで追加できる（ドラッグできない人・操作のための「＋」）
 * - ウィジェット: 種類をドラッグして置く。クリックでも追加できる
 *
 * 【誰が使うか】DashboardView（編集モードのとき）。
 * 【引数（props）】dashboard = 編集中のダッシュボード。
 */
import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { useSensors } from "../../hooks/queries";
import { useInView } from "../../hooks/useInView";
import { fetchSensorReadings, fetchSensorReadingsAggregate } from "../../lib/api";
import { useWidgetActions } from "../../hooks/useWidgetActions";
import { classifySeverity } from "../../lib/severity";
import { SENSOR_KIND_LABEL, guessSensorKind, type SensorKind } from "../../lib/sensor-kind";
import { WIDGET_KINDS } from "../../lib/widget-catalog";
import { useEditorStore } from "../../store/useEditorStore";
import type { DashboardDetail, Sensor } from "../../types";
import { WidgetIcon } from "./WidgetIcon";

export function EditorShelf({ dashboard }: { dashboard: DashboardDetail }) {
  const tab = useEditorStore((s) => s.shelfTab);
  const setTab = useEditorStore((s) => s.setShelfTab);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" className="flex border-b border-gray-200">
        {(["sensor", "widget"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`flex-1 border-b-2 px-2 py-2.5 text-sm font-semibold ${
              tab === key ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {key === "sensor" ? "センサー" : "ウィジェット"}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-auto p-2.5">
        {tab === "sensor" ? <SensorShelf dashboard={dashboard} /> : <WidgetShelf dashboard={dashboard} />}
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
  const actions = useWidgetActions(dashboard);

  const needle = query.trim().toLowerCase();
  const visible = (sensors ?? []).filter(
    (s) =>
      (filter === "all" || guessSensorKind(s) === filter) &&
      (needle === "" || `${s.name} ${s.ingestKey}`.toLowerCase().includes(needle)),
  );

  return (
    <>
      <p className="rounded-md bg-blue-50 px-2.5 py-2 text-xs text-gray-600">
        センサーをドラッグして、グラフや空きスペースに<b>ドロップ</b>。または <b>＋</b> を押すだけでも追加できます。
      </p>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="センサーを検索"
        placeholder="センサーを検索（例: 温度、ライン1）"
        className="w-full rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
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

/** 今日の 0 時（ローカル）を、分単位に丸めた ISO 文字列で返す。取得のキーが毎回変わらないようにする */
function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// 行の推移線に使う点の数と、取る期間（時間）
const SPARK_POINTS = 36;
const SPARK_HOURS = 6;
// 行の値を取り直す間隔（ミリ秒）。棚は参考表示なので、ウィジェットの 5 秒より長くする
const SHELF_REFRESH_MS = 30_000;

function SensorRow({ sensor, onAdd }: { sensor: Sensor; onAdd: () => void }) {
  const setDragging = useEditorStore((s) => s.setDragging);
  const kind = guessSensorKind(sensor);
  // 画面に見えている行だけ取得する（センサーが多くても、全行を取りに行かない）
  const { ref, inView } = useInView<HTMLLIElement>();
  const { data } = useQuery({
    queryKey: ["shelf-readings", sensor.id],
    queryFn: () => {
      const from = new Date(Date.now() - SPARK_HOURS * 60 * 60 * 1000).toISOString();
      return fetchSensorReadings(sensor.id, from, SPARK_POINTS);
    },
    enabled: inView,
    refetchInterval: inView ? SHELF_REFRESH_MS : false,
  });
  // 生産数は「いまの値」より本日の累計のほうが意味があるため、累計を出す
  const { data: today } = useQuery({
    queryKey: ["shelf-today", sensor.id],
    queryFn: () => fetchSensorReadingsAggregate(sensor.id, startOfToday()),
    enabled: inView && kind === "count",
    refetchInterval: inView ? SHELF_REFRESH_MS : false,
  });

  const newestFirst = data?.readings ?? [];
  const latest = newestFirst[0]?.value;
  const series = [...newestFirst].reverse().map((r) => r.value);

  const shown =
    kind === "count"
      ? today
        ? Math.round(today.sum).toLocaleString("ja-JP")
        : "—"
      : kind === "state"
        ? latest === undefined
          ? "—"
          : latest > 0
            ? "稼働中"
            : "停止中"
        : latest === undefined
          ? "—"
          : latest.toLocaleString("ja-JP", { maximumFractionDigits: 2 });

  // 状態の点: しきい値を超えていれば橙・赤、稼働は動いていれば緑、受信が無ければ灰色
  const dot =
    latest === undefined
      ? "bg-gray-400"
      : kind === "state"
        ? latest > 0
          ? "bg-green-600"
          : "bg-red-600"
        : { normal: "bg-green-600", warning: "bg-amber-500", critical: "bg-red-600" }[classifySeverity(latest, sensor)];

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
      <i aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 break-words text-sm font-semibold leading-tight" title={sensor.name}>{sensor.name}</div>
        <div className="text-[11px] text-gray-500">{SENSOR_KIND_LABEL[kind]}</div>
      </div>
      {kind !== "state" && <Sparkline values={series} />}
      <div className="whitespace-nowrap text-right text-sm font-bold">
        {shown}
        {kind !== "state" && sensor.unit && <small className="ml-0.5 font-normal text-gray-500">{sensor.unit}</small>}
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

/** 小さな推移線。点が2つ未満なら何も描かない */
function Sparkline({ values, width = 40, height = 18 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <span style={{ width }} aria-hidden="true" />;
  const low = Math.min(...values);
  const range = Math.max(...values) - low || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - low) / range) * (height - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline fill="none" stroke="#6b7280" strokeWidth={1.4} points={points} />
    </svg>
  );
}

function WidgetShelf({ dashboard }: { dashboard: DashboardDetail }) {
  const setDragging = useEditorStore((s) => s.setDragging);
  const actions = useWidgetActions(dashboard);

  return (
    <>
      <p className="rounded-md bg-blue-50 px-2.5 py-2 text-xs text-gray-600">
        部品をキャンバスにドラッグ。置いた場所に入ります。クリックでも追加できます。
      </p>
      <ul className="flex flex-col gap-1.5">
        {WIDGET_KINDS.map((kind) => (
          <li
            key={kind.type}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", kind.label);
              e.dataTransfer.effectAllowed = "copy";
              setDragging({ kind: "widgetType", type: kind.type });
            }}
            onDragEnd={() => setDragging(null)}
          >
            <button
              type="button"
              onClick={() => void actions.addByType(kind.type)}
              className="flex w-full cursor-grab items-start gap-2.5 rounded-lg border border-gray-200 bg-white p-2 text-left hover:border-blue-500"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600">
                <WidgetIcon type={kind.type} />
              </span>
              <span>
                <b className="block text-sm">
                  {kind.label}
                  {kind.type === "ProductionPlan" && (
                    <em className="ml-1.5 rounded bg-blue-600 px-1 py-px align-[1px] text-[10px] font-bold not-italic text-white">NEW</em>
                  )}
                </b>
                <span className="text-xs text-gray-500">{kind.description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
