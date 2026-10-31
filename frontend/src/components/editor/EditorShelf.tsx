/**
 * 編集モードの左のセンサー棚。検索と種類の絞り込み。ステータスの点・現在値・小さな推移線つき。
 * 画面にドラッグするか、行の「＋」ボタンで追加できる（ドラッグできない人・操作のための「＋」）。
 * センサーが機器に所属していれば、「機器ごと」に分けて表示できる（多数のセンサーを探しやすくする）。
 * 「名前の語」（電圧・電流など。利用者が足せる）で、名前に語を含むセンサーだけに絞れる。
 * チェックで複数を選び、棚の下の「N 個を追加」で一度に追加できる（選んだ全員を、それぞれ新しいウィジェットにする）。
 * ウィジェットの種類は、別の窓（WidgetPalette）に分けてある。
 *
 * 【誰が使うか】DashboardView（編集モードのとき）。
 * 【引数（props）】dashboard = 編集中のダッシュボード。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "../ConfirmDialog";
import { InfoButton } from "./controls";
import { ShelfGroup } from "./ShelfGroup";
import { SensorRow } from "./ShelfSensorRow";
import { ShelfWordFilter } from "./ShelfWordFilter";

import { useAlarms, useSensors } from "../../hooks/queries";
import { useMovableWindow } from "../../hooks/useMovableWindow";
import { useWidgetActions } from "../../hooks/useWidgetActions";
import { SENSOR_KIND_LABEL, guessSensorKind, type SensorKind } from "../../lib/sensor-kind";
import {
  checkStateOf,
  countByWord,
  groupByDevice,
  hasDevices,
  matchesQuery,
  matchesWord,
  worstLevel,
  type AlertLevel,
} from "../../lib/sensor-groups";
import { addWord, defaultWordFilter, loadWordFilter, removeWord, saveWordFilter, type WordFilterState } from "../../lib/sensor-words";
import { useEditorStore } from "../../store/useEditorStore";
import type { DashboardDetail, Sensor, WidgetType } from "../../types";

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
      <SensorShelf dashboard={dashboard} />
    </div>
  );
}

const KIND_FILTERS: ReadonlyArray<{ value: "all" | SensorKind; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "measure", label: SENSOR_KIND_LABEL.measure },
  { value: "count", label: SENSOR_KIND_LABEL.count },
  { value: "state", label: SENSOR_KIND_LABEL.state },
];

/** 棚の並べ方: 機器ごと / 一覧（従来）。機器に所属するセンサーがなければ、一覧だけ */
type ShelfLayout = "device" | "list";

const LAYOUTS: ReadonlyArray<{ value: ShelfLayout; label: string }> = [
  { value: "device", label: "機器ごと" },
  { value: "list", label: "一覧" },
];

// この数を超える一括追加は、確認を出す（ウィジェットが一度に大量にできるため）
const BULK_ADD_CONFIRM_COUNT = 30;
// 「すべて開く」で描く行がこの数を超えるときは、確認を出す（行ごとに値を取りにいくため重くなる）
const OPEN_ALL_CONFIRM_ROWS = 300;

/**
 * センサーごとの、未対応（未確認・確認済み）のアラームの重さ。重いほうを残す。
 * 件数を絞らずに取る（limit なし）ので、アラームが多くても点が欠けない。5 秒ごとに取り直す。
 */
function useAlertLevels(): ReadonlyMap<string, AlertLevel> {
  const { data: active } = useAlarms("active");
  const { data: acknowledged } = useAlarms("acknowledged");
  return useMemo(() => {
    const levels = new Map<string, AlertLevel>();
    for (const alarm of [...(active?.alarms ?? []), ...(acknowledged?.alarms ?? [])]) {
      if (levels.get(alarm.sensorId) !== "critical") levels.set(alarm.sensorId, alarm.severity);
    }
    return levels;
  }, [active, acknowledged]);
}

/** 確認の小窓に出す内容（実行を押したら run を呼ぶ） */
interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => void;
}

function SensorShelf({ dashboard }: { dashboard: DashboardDetail }) {
  const { data: sensors, isError } = useSensors();
  const alertLevels = useAlertLevels();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | SensorKind>("all");
  const [alertOnly, setAlertOnly] = useState(false);
  const [wordFilter, setWordFilter] = useState<WordFilterState>(loadWordFilter);
  const [layoutChoice, setLayoutChoice] = useState<ShelfLayout | null>(null);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const actions = useWidgetActions(dashboard);
  // 追加中かの同期的な目印（state は次の描画まで変わらないので、続けて押された分を止めるのに使う）
  const addingRef = useRef(false);

  const all = useMemo(() => sensors ?? [], [sensors]);
  const devicesExist = useMemo(() => hasDevices(all), [all]);
  // 選ばなければ、機器があるときは「機器ごと」、なければ従来の一覧
  const layout: ShelfLayout = devicesExist ? (layoutChoice ?? "device") : "list";

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      all.filter(
        (s) =>
          (filter === "all" || guessSensorKind(s) === filter) &&
          (!alertOnly || alertLevels.has(s.id)) &&
          matchesWord(s, wordFilter.selected) &&
          matchesQuery(s, needle),
      ),
    [all, filter, alertOnly, alertLevels, wordFilter.selected, needle],
  );
  // 語ごとの件数は、ほかの絞り込みに関係なく、全センサーで数える
  const wordCounts = useMemo(() => countByWord(all, wordFilter.words), [all, wordFilter.words]);
  const groups = useMemo(() => (layout === "device" ? groupByDevice(visible) : []), [layout, visible]);
  const levelByGroup = useMemo(
    () => new Map(groups.map((g) => [g.id, worstLevel(g.sensors, alertLevels)])),
    [groups, alertLevels],
  );
  const checkByGroup = useMemo(
    () => new Map(groups.map((g) => [g.id, checkStateOf(g.sensors, selectedIds)])),
    [groups, selectedIds],
  );
  // 検索中・要注意・語の絞り込み中は、当たったグループをすべて開いて見せる（開閉はできない）
  const showAllGroups = needle !== "" || alertOnly || wordFilter.selected !== null;

  const selectedSensors = useMemo(() => all.filter((s) => selectedIds.has(s.id)), [all, selectedIds]);
  const visibleIds = useMemo(() => new Set(visible.map((s) => s.id)), [visible]);
  const hiddenSelectedCount = selectedSensors.filter((s) => !visibleIds.has(s.id)).length;
  const allVisibleSelected = visible.length > 0 && visible.every((s) => selectedIds.has(s.id));

  // 子（グループ・行）へ渡す操作は、描画のたびに作り直さない（props が同じなら、子を描き直さないため）
  const toggleOpen = useCallback(
    (groupId: string) =>
      setOpenGroups((open) => {
        const next = new Set(open);
        if (!next.delete(groupId)) next.add(groupId);
        return next;
      }),
    [],
  );
  // 渡したセンサーを、全員が選択済みなら外し、そうでなければ全員を選ぶ
  const toggleSelection = useCallback(
    (targets: Sensor[]) =>
      setSelectedIds((selected) => {
        const next = new Set(selected);
        const everyoneSelected = targets.every((s) => next.has(s.id));
        for (const sensor of targets) {
          if (everyoneSelected) next.delete(sensor.id);
          else next.add(sensor.id);
        }
        return next;
      }),
    [],
  );
  const toggleOne = useCallback((sensor: Sensor) => toggleSelection([sensor]), [toggleSelection]);

  // 最新の値を読む操作（追加）。描画のたびに作り直される actions を、安定した関数から呼ぶための入れ物
  const latest = useRef<{ actions: typeof actions; requestAddMany: (targets: Sensor[]) => void }>({
    actions,
    requestAddMany: () => undefined,
  });
  const addOne = useCallback((sensor: Sensor) => void latest.current.actions.addSensor(sensor), []);
  const addOneAs = useCallback(
    (sensor: Sensor, type: WidgetType) => void latest.current.actions.addSensor(sensor, undefined, type),
    [],
  );
  const addAll = useCallback((targets: Sensor[]) => latest.current.requestAddMany(targets), []);

  /**
   * 一括追加の本体。成功と失敗を数えて 1 回だけ知らせ、失敗したセンサーは選択に残す（やり直せるように）。
   * 追加中は二重に実行しない。
   */
  const runAddMany = async (targets: Sensor[]) => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    try {
      const { added, failed } = await actions.addSensors(targets);
      const message =
        failed.length === 0
          ? `${added.length} 個のセンサーを追加しました`
          : `${targets.length} 個中 ${added.length} 個を追加しました（${failed.length} 個は失敗）`;
      useEditorStore.getState().showToast(message);
      setSelectedIds((selected) => {
        const next = new Set(selected);
        for (const sensor of added) next.delete(sensor.id);
        for (const sensor of failed) next.add(sensor.id);
        return next;
      });
    } catch {
      useEditorStore.getState().showToast("センサーの追加に失敗しました");
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };
  const requestAddMany = (targets: Sensor[]) => {
    if (targets.length === 0 || addingRef.current) return;
    if (targets.length <= BULK_ADD_CONFIRM_COUNT) {
      void runAddMany(targets);
      return;
    }
    setConfirm({
      title: "センサーをまとめて追加",
      message: `${targets.length} 個のセンサーを、それぞれ新しいウィジェットとして追加します。よろしいですか？`,
      confirmLabel: "追加",
      run: () => void runAddMany(targets),
    });
  };
  useEffect(() => {
    latest.current = { actions, requestAddMany };
  });

  // 語の状態を変えたら、すぐ保存する
  const changeWordFilter = (next: WordFilterState) => {
    setWordFilter(next);
    saveWordFilter(next);
  };
  const addWordFromInput = (input: string): string | null => {
    const result = addWord(wordFilter.words, input);
    if (!result.ok) return result.message;
    changeWordFilter({ ...wordFilter, words: result.words });
    return null;
  };

  const toggleAllOpen = () => {
    if (openGroups.size > 0) {
      setOpenGroups(new Set());
      return;
    }
    const openAll = () => setOpenGroups(new Set(groups.map((g) => g.id)));
    if (visible.length <= OPEN_ALL_CONFIRM_ROWS) {
      openAll();
      return;
    }
    setConfirm({
      title: "すべての機器を開く",
      message: `${visible.length} 個のセンサーの行を、すべて表示します。動作が重くなることがあります。よろしいですか？`,
      confirmLabel: "開く",
      run: openAll,
    });
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2.5">
        <div className="flex items-center gap-1.5">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="センサーを検索"
            placeholder="🔍 検索"
            title="センサーを検索（例: 温度、ライン1、機器名）"
            className="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-sm"
          />
          <InfoButton label="センサー棚" open={helpOpen} onToggle={() => setHelpOpen((o) => !o)} />
        </div>
        {helpOpen && (
          <p className="rounded-md bg-blue-50 px-2.5 py-2 text-xs text-gray-600">
            センサーをドラッグして、グラフや空きスペースに<b>ドロップ</b>。または <b>＋</b> を押すだけでも追加できます。
            チェックで複数を選ぶと、下の<b>「N 個を追加」</b>で一度に追加できます（それぞれ新しいウィジェットになります）。
          </p>
        )}
        {devicesExist && (
          <div role="group" aria-label="センサーの並べ方" className="grid grid-flow-col auto-cols-fr overflow-hidden rounded-md border border-gray-300">
            {LAYOUTS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={layout === item.value}
                onClick={() => setLayoutChoice(item.value)}
                className={`px-1 py-1 text-xs ${layout === item.value ? "bg-blue-600 text-white" : "bg-white text-gray-700"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
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
          <button
            type="button"
            aria-pressed={alertOnly}
            onClick={() => setAlertOnly((on) => !on)}
            title="未対応のアラームがあるセンサーだけを表示"
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              alertOnly ? "border-red-600 bg-red-600 text-white" : "border-gray-300 bg-white text-gray-700"
            }`}
          >
            要注意のみ
          </button>
        </div>
        <ShelfWordFilter
          words={wordFilter.words}
          selected={wordFilter.selected}
          counts={wordCounts}
          onSelect={(word) => changeWordFilter({ ...wordFilter, selected: word })}
          onAdd={addWordFromInput}
          onRemove={(word) => changeWordFilter(removeWord(wordFilter, word))}
          onReset={() => changeWordFilter(defaultWordFilter())}
        />
        {all.length > 0 && (
          <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
            <span>
              {visible.length} 個{layout === "device" ? ` / ${groups.length} 機器` : ""}
            </span>
            <span className="flex items-center gap-2">
              <button type="button" onClick={() => toggleSelection(visible)} disabled={visible.length === 0} className="text-blue-600 disabled:text-gray-400">
                {allVisibleSelected ? "表示中の選択を外す" : "表示中をすべて選択"}
              </button>
              {layout === "device" && !showAllGroups && (
                <button type="button" onClick={toggleAllOpen} className="text-blue-600">
                  {openGroups.size > 0 ? "すべて閉じる" : "すべて開く"}
                </button>
              )}
            </span>
          </div>
        )}
        <ul className="flex flex-col gap-1.5">
          {layout === "device"
            ? groups.map((group) => {
                const open = showAllGroups || openGroups.has(group.id);
                return (
                  <ShelfGroup
                    key={group.id}
                    group={group}
                    needle={needle}
                    open={open}
                    locked={showAllGroups}
                    busy={adding}
                    level={levelByGroup.get(group.id) ?? "none"}
                    checkState={checkByGroup.get(group.id) ?? "none"}
                    selectedIds={open ? selectedIds : null}
                    onToggleOpen={toggleOpen}
                    onToggleCheck={toggleSelection}
                    onAddAll={addAll}
                    onToggleSelect={toggleOne}
                    onAdd={addOne}
                    onAddAs={addOneAs}
                  />
                );
              })
            : visible.map((sensor) => (
                <SensorRow
                  key={sensor.id}
                  sensor={sensor}
                  needle={needle}
                  selected={selectedIds.has(sensor.id)}
                  onToggleSelect={toggleOne}
                  onAdd={addOne}
                  onAddAs={addOneAs}
                />
              ))}
        </ul>
        {isError && <p className="text-xs text-red-600">センサーを取得できませんでした。</p>}
        {sensors && visible.length === 0 && (
          <p className="py-3 text-center text-sm text-gray-500">
            {sensors.length === 0 ? "センサーがまだありません。設定画面から登録してください。" : "該当するセンサーがありません"}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-gray-200 bg-gray-50 px-2.5 py-2">
        <span className="min-w-0 flex-1 text-xs text-gray-600">
          {selectedSensors.length > 0 ? `${selectedSensors.length} 個を選択中` : "チェックして、まとめて追加"}
          {hiddenSelectedCount > 0 && `（うち ${hiddenSelectedCount} 個は表示外）`}
        </span>
        <button
          type="button"
          onClick={() => setSelectedIds(new Set())}
          disabled={selectedSensors.length === 0 || adding}
          className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs disabled:opacity-40"
        >
          解除
        </button>
        <button
          type="button"
          onClick={() => requestAddMany(selectedSensors)}
          disabled={selectedSensors.length === 0 || adding}
          className="rounded-md border border-blue-600 bg-blue-600 px-2.5 py-1 text-xs font-bold text-white disabled:opacity-40"
        >
          {adding ? "追加中…" : selectedSensors.length > 0 ? `${selectedSensors.length} 個を追加` : "追加"}
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => {
            const { run } = confirm;
            setConfirm(null);
            run();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
