/**
 * センサー棚の「系統 › 機器」の、系統 1 つ分（見出し + 開いたときの機器のグループ）。
 * 見出し: チェックボックス（系統の表示中のセンサーをすべて選ぶ。一部だけ選んだ状態は ■）・開閉・系統名・「N 機器 / M 個」・状態の点。
 * 閉じている系統の中は描画しない。props が変わらない系統は描き直さない（memo）。
 *
 * 【誰が使うか】EditorShelf。
 * 【引数（props）】line = 表示する系統（検索・絞り込み済み）、needle = 検索の文字（小文字）、open / locked = 開いているか・開きっぱなしか、
 * busy = 追加中、level / checkState = 系統の状態の点・選択の状態、
 * openGroups / selectedIds / alertLevels = 中の機器の開閉・選択・アラームの状態（閉じている系統には null を渡して、変わっても描き直さない）、
 * 操作の関数 = ShelfGroup と同じ（どの系統・機器・センサーかは引数で渡す）。
 */
import { memo, useEffect, useId, useRef } from "react";

import { Highlight } from "./Highlight";
import { ShelfGroup } from "./ShelfGroup";

import { LEVEL_DOT } from "../../lib/alert-dot";
import {
  checkStateOf,
  worstLevel,
  type AlertLevel,
  type CheckState,
  type LineGroup,
} from "../../lib/sensor-groups";
import type { Sensor, WidgetType } from "../../types";

interface Props {
  line: LineGroup;
  needle: string;
  open: boolean;
  locked: boolean;
  busy: boolean;
  level: AlertLevel;
  checkState: CheckState;
  openGroups: ReadonlySet<string> | null;
  selectedIds: ReadonlySet<string> | null;
  alertLevels: ReadonlyMap<string, AlertLevel> | null;
  onToggleOpen: (groupId: string) => void;
  onToggleCheck: (sensors: Sensor[]) => void;
  onAddAll: (sensors: Sensor[]) => void;
  onToggleSelect: (sensor: Sensor) => void;
  onAdd: (sensor: Sensor) => void;
  onAddAs: (sensor: Sensor, type: WidgetType) => void;
}

const NO_SELECTION: ReadonlySet<string> = new Set();
const NO_ALERTS: ReadonlyMap<string, AlertLevel> = new Map();

export const ShelfLineGroup = memo(function ShelfLineGroup({
  line,
  needle,
  open,
  locked,
  busy,
  level,
  checkState,
  openGroups,
  selectedIds,
  alertLevels,
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
  // aria-controls 用の id。系統名（空白・記号を含みうる）は使わず、React が作る安全な id にする
  const devicesId = useId();
  return (
    <li className="overflow-hidden rounded-lg border border-blue-200 bg-white">
      <div className="flex items-center gap-1.5 bg-blue-50 px-2 py-1.5">
        <input
          ref={checkRef}
          type="checkbox"
          checked={checkState === "all"}
          onChange={() => onToggleCheck(line.sensors)}
          aria-label={`${line.name}の表示中のセンサーをすべて選ぶ`}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer"
        />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={devicesId}
          aria-label={`${line.name}（${line.devices.length} 機器 / ${line.sensors.length} 個）`}
          disabled={locked}
          title={locked ? "検索・絞り込み中は、当たった系統をすべて開いて表示しています" : undefined}
          onClick={() => onToggleOpen(line.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
        >
          <span aria-hidden="true" className={`w-3 text-[10px] text-gray-500 ${open ? "rotate-90" : ""}`}>
            ▶
          </span>
          <i aria-hidden="true" title={dot.label} className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot.className}`} />
          <span className="min-w-0 truncate text-sm font-bold" title={line.name}>
            <Highlight text={line.name} needle={needle} />
          </span>
          <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-gray-500">
            {line.devices.length} 機器 / {line.sensors.length} 個
          </span>
        </button>
      </div>
      {open && (
        <ul id={devicesId} className="flex flex-col gap-1.5 p-1.5">
          {line.devices.map((device) => {
            const deviceOpen = locked || (openGroups?.has(device.id) ?? false);
            return (
              <ShelfGroup
                key={device.id}
                group={device}
                needle={needle}
                open={deviceOpen}
                locked={locked}
                busy={busy}
                level={worstLevel(device.sensors, alertLevels ?? NO_ALERTS)}
                checkState={checkStateOf(device.sensors, selectedIds ?? NO_SELECTION)}
                selectedIds={deviceOpen ? selectedIds : null}
                onToggleOpen={onToggleOpen}
                onToggleCheck={onToggleCheck}
                onAddAll={onAddAll}
                onToggleSelect={onToggleSelect}
                onAdd={onAdd}
                onAddAs={onAddAs}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
});
