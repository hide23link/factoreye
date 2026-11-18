/**
 * センサーの管理パネル（設定 › センサー）。画面刷新モックの形: 検索・絞り込み・追加ボタンの上の行と、
 * 機器ごとにまとめたセンサーの表（種類・今の値・直近 1 時間の小さな折れ線・1 時間の最低〜最高・しきい値・最終受信・状態）。
 * 行を押すと、右に詳細の欄（SensorDetailPane。24 時間のグラフ・設定の入力・詳しい設定）を開く。
 *
 * 「＋センサーを追加」で、新規登録のフォーム（種類のカード・名前・Ingest Key・単位）を開く（センサーが 0 件のときは最初から開く）。
 * Free Tier の上限に達すると、案内を出す。登録に成功すると「つなぎ方」の案内（SensorConnectGuide）を出す。
 * 機器が多いときは、最初の 3 機器だけ開き、「ほかの N 機器を開く」で残りを出す（検索・絞り込み中と、選んだセンサーの機器は常に出す）。
 * 行は一度に 50 件まで（「もっと見る」で 50 件ずつ）。詳細の欄を開いている間は、表が狭いので、種類・直近 1 時間・最終受信の列を隠す。
 *
 * 【誰が使うか】SettingsPage.tsx が、選んだタブのときだけ出す。引数（props）はない。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";

import { useDownsampledReadings, useLatestReadings, useSensors } from "../../hooks/queries";
import { useNow } from "../../hooks/useNow";
import { createSensor } from "../../lib/api";
import { describeSensorError } from "../../lib/errors";
import { FREE_TIER_LIMIT_MESSAGE, isFreeTierLimitError } from "../../lib/freeTier";
import { formatAge } from "../../lib/overview";
import { SENSOR_KIND_LABEL, guessSensorKind } from "../../lib/sensor-kind";
import {
  filterCounts,
  formatLiveValue,
  groupByDevice,
  hourRange,
  matchesFilter,
  matchesQuery,
  sensorLive,
  sensorStatus,
  sparkSegments,
  thresholdSummary,
  type ListFilter,
  type SensorGroup,
  type SensorLive,
  type SensorStatus,
} from "../../lib/sensor-list";
import { validateSensorBasics } from "../../lib/sensor-validation";
import { useUiStore } from "../../store/useUiStore";
import type { Sensor } from "../../types";
import { ErrorNotice } from "../ErrorNotice";
import { UnitSelect } from "../UnitSelect";
import { SensorConnectGuide } from "./SensorConnectGuide";
import { SensorDetailPane } from "./SensorDetailPane";

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

// 絞り込みのボタン（名前と、条件。条件は lib/sensor-list.ts の matchesFilter）。tone は数字の色（止まっている=橙、しきい値の外=赤）
const FILTERS: ReadonlyArray<{ value: ListFilter; label: string; tone?: string }> = [
  { value: "all", label: "すべて" },
  { value: "receiving", label: "受信中" },
  { value: "stopped", label: "止まっている", tone: "var(--fe-amb)" },
  { value: "outside", label: "しきい値の外", tone: "var(--fe-red)" },
];

// 最初に開く機器の数（これより多いときは「ほかの N 機器を開く」）
const OPEN_DEVICE_COUNT = 3;

// 表の見出しの文字の形（折り返さない）
const HEAD = "whitespace-nowrap px-2 py-1.5";

// 状態の列の文字と色（操作室の計器と同じ色づかい）
const STATUS_VIEW: Record<SensorStatus, { text: string; mark: string; color: string }> = {
  normal: { text: "正常", mark: "■", color: "var(--fe-ok)" },
  outside: { text: "しきい値の外", mark: "▲", color: "var(--fe-red)" },
  stopped: { text: "受信なし", mark: "●", color: "var(--fe-amb)" },
  never: { text: "未受信", mark: "○", color: "var(--fe-mut)" },
  disabled: { text: "無効", mark: "—", color: "var(--fe-mut)" },
};

// 一度に出す行の数の上限（これを超えるときは「もっと見る」）。行ごとに 1 時間分のデータを取るので、取得の数を抑える
const ROW_LIMIT = 50;

/** 直近 1 時間の小さな折れ線（飾り。数字は隣の列に出ている）。受信が途切れた所は線を切って空ける */
function Sparkline({ segments, color }: { segments: ReadonlyArray<string>; color: string }) {
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-24" aria-hidden="true">
      {segments.map((points) => (
        <polyline key={points} points={points} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

/**
 * センサー 1 件の行。今の値・直近 1 時間の折れ線・最低〜最高は、行ごとに 1 時間分の区間データを取って出す
 * （1 分ごとに取り直す。表示している行だけ取る。無効のセンサーと、まだ受信が無いセンサーは取らない）。
 * compact = 右に詳細の欄を開いていて、表が狭いとき。種類・直近 1 時間・最終受信の列を隠す。
 */
function SensorListRow({
  sensor,
  live,
  now,
  selected,
  compact,
  onSelect,
}: {
  sensor: Sensor;
  live: SensorLive;
  now: number;
  selected: boolean;
  compact: boolean;
  onSelect: (sensorId: string) => void;
}) {
  // 取得の範囲は分の区切りにそろえる（10 秒ごとに時刻が動いても、取り直すのは 1 分に 1 回）
  const minute = Math.floor(now / 60_000) * 60_000;
  const from = minute - 3_600_000;
  // 無効のセンサーと、まだ受信が無いセンサー（折れ線も最低〜最高も出ない）は、取りに行かない
  const fetchId = sensor.enabled && live.state !== "never" ? sensor.id : null;
  const { data } = useDownsampledReadings(fetchId, { from, to: minute }, 30, false);
  const buckets = data?.buckets ?? [];
  const range = hourRange(buckets);
  const status = sensorStatus(sensor, live);
  const view = STATUS_VIEW[status];
  const stopped = live.state !== "receiving";
  // 今の値の色: 無効は灰、受信が止まっていれば橙、しきい値の外は赤・橙
  const valueColor = !sensor.enabled ? "var(--fe-mut)" : stopped ? "var(--fe-amb)" : live.level === "critical" ? "var(--fe-red)" : live.level === "warning" ? "var(--fe-amb)" : undefined;
  const cell = "whitespace-nowrap px-2 py-2 align-middle";

  return (
    <tr
      onClick={() => onSelect(sensor.id)}
      className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${selected ? "bg-blue-50" : ""} ${sensor.enabled ? "" : "opacity-60"}`}
    >
      <td className={`${cell} text-sm font-bold text-gray-900`}>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(sensor.id);
          }}
          aria-pressed={selected}
          aria-label={`${sensor.name} の詳細`}
          title="右に詳細を開く"
          className="block max-w-[16rem] truncate text-left hover:underline"
        >
          {sensor.name}
        </button>
      </td>
      {!compact && <td className={`${cell} text-xs text-gray-500`}>{SENSOR_KIND_LABEL[guessSensorKind(sensor)]}</td>}
      <td className={`${cell} text-right font-num text-sm font-bold`} style={{ color: valueColor }}>
        {live.latest && !stopped ? formatLiveValue(live.latest.value) : "---"} <span className="text-xs font-normal text-gray-500">{sensor.unit}</span>
      </td>
      {!compact && (
        <td className={cell}>
          <Sparkline
            segments={data ? sparkSegments(buckets, data.bucketSeconds, from, minute, 100, 24) : []}
            color={view.color === "var(--fe-mut)" ? "var(--fe-mut)" : stopped || status === "outside" ? view.color : "var(--fe-ink)"}
          />
        </td>
      )}
      <td className={`${cell} font-num text-xs text-gray-700`}>{range ? `${formatLiveValue(range.min)} — ${formatLiveValue(range.max)}` : "—"}</td>
      <td className={`${cell} font-num text-xs`} style={{ color: "var(--fe-cy)" }}>
        {thresholdSummary(sensor)}
      </td>
      {!compact && <td className={`${cell} font-num text-xs text-gray-700`}>{live.ageMs === null ? "—" : formatAge(live.ageMs)}</td>}
      <td className={`${cell} text-xs font-bold`} style={{ color: view.color }}>
        {view.mark} {view.text}
      </td>
    </tr>
  );
}

/** 機器ごとのまとまり（見出しの行と、その機器のセンサーの行） */
function SensorGroupRows({
  group,
  showTitle,
  lives,
  now,
  selectedId,
  compact,
  onSelect,
}: {
  group: SensorGroup;
  showTitle: boolean;
  lives: ReadonlyMap<string, SensorLive>;
  now: number;
  selectedId: string | null;
  compact: boolean;
  onSelect: (sensorId: string) => void;
}) {
  return (
    <Fragment>
      {showTitle && (
        <tr className="bg-gray-100">
          <td colSpan={compact ? 5 : 8} className="px-2 py-1 text-[11px] font-bold tracking-wide text-gray-600">
            {group.title}
            {group.line ? ` · ${group.line}` : ""}
            <span className="ml-2 font-num font-normal">{group.sensors.length} センサー</span>
          </td>
        </tr>
      )}
      {group.sensors.map((sensor) => {
        const live = lives.get(sensor.id);
        return live ? <SensorListRow key={sensor.id} sensor={sensor} live={live} now={now} selected={sensor.id === selectedId} compact={compact} onSelect={onSelect} /> : null;
      })}
    </Fragment>
  );
}

/** センサー設定パネル（上の操作の行・新規登録フォーム・センサーの表・右の詳細）。 */
export function SensorSettingsPanel() {
  const { data: sensors, isLoading, isError, refetch } = useSensors();
  // 一覧の受信の状態（今の値・最後の受信）に使う、全センサーの最新の測定値（1 回の取得）
  const { data: latestData } = useLatestReadings();
  const now = useNow(10_000);
  const queryClient = useQueryClient();
  const setView = useUiStore((s) => s.setView);
  // 検索の文字・絞り込みのボタン・詳細を出しているセンサー・「ほかの機器」を開いたか・追加フォームを開いたか
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAllDevices, setShowAllDevices] = useState(false);
  // 出す行の数の上限（「もっと見る」で 50 ずつ増やす。検索・絞り込みを変えたら戻す）
  const [rowLimit, setRowLimit] = useState(ROW_LIMIT);
  const [showAdd, setShowAdd] = useState(false);

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
      setShowAdd(false);
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
  // 最初の 3 機器だけ開く。検索・絞り込み中と、選んだセンサーの機器は、閉じない
  const narrowing = query.trim() !== "" || filter !== "all";
  const shownGroups =
    showAllDevices || narrowing || !showGroups
      ? groups
      : groups.filter((group, index) => index < OPEN_DEVICE_COUNT || group.sensors.some((sensor) => sensor.id === selectedId));
  const hiddenDevices = groups.length - shownGroups.length;
  // 行は、上から rowLimit 件まで（行ごとに 1 時間分のデータを取るので、数を抑える）
  let remaining = rowLimit;
  const limitedGroups = shownGroups
    .map((group) => {
      const sensorsInGroup = group.sensors.slice(0, Math.max(0, remaining));
      remaining -= sensorsInGroup.length;
      return { ...group, sensors: sensorsInGroup };
    })
    .filter((group) => group.sensors.length > 0);
  const hiddenRows = shownGroups.reduce((sum, group) => sum + group.sensors.length, 0) - limitedGroups.reduce((sum, group) => sum + group.sensors.length, 0);
  const selected = (sensors ?? []).find((sensor) => sensor.id === selectedId);
  // 追加フォームは、「＋センサーを追加」で開く。センサーが 1 つも無いときは、最初から開く
  const addOpen = showAdd || sensors?.length === 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-lg font-bold text-gray-900">センサー</h2>
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
            onChange={(event) => {
              setQuery(event.target.value);
              setRowLimit(ROW_LIMIT);
            }}
            className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none"
          />
        </label>
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={filter === item.value}
            onClick={() => {
              setFilter(item.value);
              setRowLimit(ROW_LIMIT);
            }}
            className={`h-8 rounded border px-2.5 text-xs ${
              filter === item.value ? "border-blue-600 bg-blue-50 font-bold text-blue-700" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-100"
            }`}
            style={item.tone && counts[item.value] > 0 ? { color: item.tone } : undefined}
          >
            {item.label} <span className="font-num">{counts[item.value]}</span>
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setView("wizard")}
          title="セットアップガイドで、センサーの登録からデータ送信までを順に進める"
          className="h-8 rounded border border-gray-300 bg-white px-3 text-xs text-gray-700 hover:bg-gray-100"
        >
          つなぎ方
        </button>
        <button
          type="button"
          aria-expanded={addOpen}
          onClick={() => setShowAdd((open) => !open)}
          className="h-8 rounded bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-700"
        >
          ＋センサーを追加
        </button>
      </div>

      {justCreated && <SensorConnectGuide key={justCreated.id} sensor={justCreated} onClose={() => setJustCreated(null)} />}

      {addOpen && (
        <>
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
            className="mb-2 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3"
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
          <p className="mb-3 text-xs text-gray-500">しきい値（軽故障・重故障・不感帯）は作成後、一覧の行を押して右の詳細で設定します。</p>
        </>
      )}
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
        <div className={selected ? "grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_340px]" : ""}>
          <div className="min-w-0 overflow-x-auto">
            {/* 狭いときは、表の最小幅を決めて横にスクロールする（列が詰まって文字が縦に折れないように） */}
            <table className={`w-full border-collapse text-left ${selected ? "min-w-[520px]" : "min-w-[760px]"}`}>
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className={HEAD}>名前</th>
                  {!selected && <th className={HEAD}>種類</th>}
                  <th className={`${HEAD} text-right`}>今の値</th>
                  {!selected && <th className={HEAD}>直近 1 時間</th>}
                  <th className={HEAD}>1h 最低 — 最高</th>
                  <th className={HEAD}>しきい値</th>
                  {!selected && <th className={HEAD}>最終受信</th>}
                  <th className={HEAD}>状態</th>
                </tr>
              </thead>
              <tbody>
                {limitedGroups.map((group) => (
                  <SensorGroupRows key={group.key} group={group} showTitle={showGroups} lives={lives} now={now} selectedId={selectedId} compact={Boolean(selected)} onSelect={(id) => setSelectedId((current) => (current === id ? null : id))} />
                ))}
              </tbody>
            </table>
            {visible.length === 0 && <p className="py-3 text-sm text-gray-500">該当するセンサーはありません。</p>}
            <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
              <span>名前を押すと、右に詳細</span>
              {hiddenRows > 0 && (
                <button type="button" onClick={() => setRowLimit((limit) => limit + ROW_LIMIT)} className="text-blue-600 hover:underline">
                  もっと見る（残り {hiddenRows} 件）
                </button>
              )}
              {hiddenDevices > 0 && (
                <button type="button" onClick={() => setShowAllDevices(true)} className="text-blue-600 hover:underline">
                  ほかの {hiddenDevices} 機器を開く
                </button>
              )}
            </div>
          </div>
          {selected && (
            <SensorDetailPane
              key={selected.id}
              sensor={selected}
              live={lives.get(selected.id)}
              onClose={() => setSelectedId(null)}
              // 削除したセンサーの「つなぎ方」の案内は、閉じる（削除済みのセンサーを待ち続けないように）
              onDeleted={(id) => {
                setJustCreated((current) => (current?.id === id ? null : current));
                setSelectedId((current) => (current === id ? null : current));
              }}
            />
          )}
        </div>
      )}

      {!isLoading && sensors?.length === 0 && (
        <p className="text-sm text-gray-500">まだセンサーが登録されていません。</p>
      )}
    </div>
  );
}
