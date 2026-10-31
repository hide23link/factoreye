/**
 * センサー棚の「機器ごと」の 1 グループ（見出し + 開いたときのセンサーの行）。
 * 見出し: チェックボックス（グループ全体を選ぶ。一部だけ選んだ状態は ■）・開閉・機器名・センサー数・状態の点・「すべて追加」。
 * 閉じているグループの行は描画しない（センサーが多くても重くならない）。props が変わらないグループは描き直さない（memo）。
 *
 * 【誰が使うか】EditorShelf。
 * 【引数（props）】group = 表示するセンサー（検索・絞り込み済み）、needle = 検索の文字（小文字）、open = 開いているか、
 * locked = 検索中などで開きっぱなし（開閉できない）、busy = 追加中（「すべて追加」を押せない）、
 * level = 未対応のアラームの重さ（見出しの点）、checkState = 選択の状態、
 * selectedIds = 選択中の id（行のチェックに使う。閉じているグループには null を渡して、選択が変わっても描き直さない）、
 * onToggleOpen / onToggleCheck / onAddAll / 行の操作 = 操作（どのグループ・センサーかは引数で渡す。呼ぶ側は同じ関数を渡し続けられる）。
 */
import { memo, useEffect, useId, useRef } from "react";

import { Highlight } from "./Highlight";
import { SensorRow } from "./ShelfSensorRow";

import { LEVEL_DOT } from "../../lib/alert-dot";
import type { AlertLevel, CheckState, SensorGroup } from "../../lib/sensor-groups";
import type { Sensor, WidgetType } from "../../types";

interface Props {
  group: SensorGroup;
  needle: string;
  open: boolean;
  locked: boolean;
  busy: boolean;
  level: AlertLevel;
  checkState: CheckState;
  selectedIds: ReadonlySet<string> | null;
  onToggleOpen: (groupId: string) => void;
  onToggleCheck: (sensors: Sensor[]) => void;
  onAddAll: (sensors: Sensor[]) => void;
  onToggleSelect: (sensor: Sensor) => void;
  onAdd: (sensor: Sensor) => void;
  onAddAs: (sensor: Sensor, type: WidgetType) => void;
}

export const ShelfGroup = memo(function ShelfGroup({
  group,
  needle,
  open,
  locked,
  busy,
  level,
  checkState,
  selectedIds,
  onToggleOpen,
  onToggleCheck,
  onAddAll,
  onToggleSelect,
  onAdd,
  onAddAs,
}: Props) {
  const checkRef = useRef<HTMLInputElement>(null);
  // 「一部だけ選んだ」状態は、属性ではなく DOM の項目で指定する
  useEffect(() => {
    if (checkRef.current) checkRef.current.indeterminate = checkState === "some";
  }, [checkState]);

  const dot = LEVEL_DOT[level];
  const rowsId = useId(); // aria-controls 用の id（機器名などは使わず、React が作る安全な id にする）
  return (
    <li className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-1.5 bg-gray-50 px-2 py-1.5">
        <input
          ref={checkRef}
          type="checkbox"
          checked={checkState === "all"}
          onChange={() => onToggleCheck(group.sensors)}
          aria-label={`${group.name}の表示中のセンサーをすべて選ぶ`}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer"
        />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={rowsId}
          aria-label={`${group.name}（${group.sensors.length} 個）`}
          disabled={locked}
          title={locked ? "検索・絞り込み中は、当たった機器をすべて開いて表示しています" : undefined}
          onClick={() => onToggleOpen(group.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
        >
          <span aria-hidden="true" className={`w-3 text-[10px] text-gray-500 ${open ? "rotate-90" : ""}`}>
            ▶
          </span>
          <i aria-hidden="true" title={dot.label} className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot.className}`} />
          <span className="min-w-0 truncate text-sm font-bold" title={group.name}>
            <Highlight text={group.name} needle={needle} />
          </span>
          <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-gray-500">{group.sensors.length}</span>
        </button>
        <button
          type="button"
          onClick={() => onAddAll(group.sensors)}
          disabled={busy}
          aria-label={`${group.name}のセンサーをすべて追加`}
          title="チェックなしで、この機器の表示中のセンサーをまとめて追加"
          className="shrink-0 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] hover:border-blue-600 hover:text-blue-600 disabled:opacity-40"
        >
          すべて追加
        </button>
      </div>
      {open && (
        <ul id={rowsId} className="flex flex-col gap-1.5 p-1.5">
          {group.sensors.map((sensor) => (
            <SensorRow
              key={sensor.id}
              sensor={sensor}
              needle={needle}
              selected={selectedIds?.has(sensor.id) ?? false}
              onToggleSelect={onToggleSelect}
              onAdd={onAdd}
              onAddAs={onAddAs}
            />
          ))}
        </ul>
      )}
    </li>
  );
});
