/**
 * 単位の選択欄。プルダウンで候補（lib/units.ts）を全部選べ、「その他」を選ぶと自由に入力できる。
 *
 * <input list> + <datalist> は、入力済みの値で候補が絞り込まれ、初期値の「°C」だけしか出なくなるため使わない。
 * 候補に無い既存の単位は、「その他」の入力欄にそのまま表示し、そのまま保存できる。
 *
 * 【誰が使うか】SensorSettingsPanel（作成フォーム・編集行）、SetupWizard。
 * 【引数（props）】value = 今の単位、onChange = 変えたとき、label = 読み上げ用の名前、className = 外側の幅など。
 */
import { useEffect, useRef, useState } from "react";

import { OTHER_UNIT, UNIT_PRESETS, isPresetUnit } from "../lib/units";

export function UnitSelect({
  value,
  onChange,
  label = "単位",
  className = "",
}: {
  value: string;
  onChange: (unit: string) => void;
  label?: string;
  className?: string;
}) {
  // 「その他」を選んだ。入力中に値がたまたま候補と一致しても（「L」→「L/h」の途中など）、入力欄は消さない。
  // 解除するのは、プルダウンで候補を選んだときと、親が値を候補に戻したとき（下の effect）だけ
  const [pickedOther, setPickedOther] = useState(false);
  // この部品が最後に親へ伝えた値。これと違う候補の値が来たら、親が戻した（リセットした）とみなす
  const lastEmitted = useRef(value);
  const emit = (next: string) => {
    lastEmitted.current = next;
    onChange(next);
  };
  const isOther = pickedOther || (value !== "" && !isPresetUnit(value));
  const selected = isOther ? OTHER_UNIT : value;
  useEffect(() => {
    if (value !== lastEmitted.current && isPresetUnit(value)) setPickedOther(false);
    lastEmitted.current = value;
  }, [value]);

  return (
    <span className={`inline-flex flex-col gap-1 ${className}`}>
      <select
        aria-label={label}
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          if (next === OTHER_UNIT) {
            setPickedOther(true);
            // 候補だった値を、そのまま「その他」の初期値にしない（選び直した意図を空欄で示す）
            if (isPresetUnit(value)) emit("");
            return;
          }
          setPickedOther(false);
          emit(next);
        }}
        className="rounded border border-gray-300 bg-white px-2 py-1 text-sm"
      >
        <option value="">選択してください</option>
        {UNIT_PRESETS.map((preset) => (
          <option key={preset.value} value={preset.value}>
            {preset.value}（{preset.hint}）
          </option>
        ))}
        <option value={OTHER_UNIT}>その他（自由入力）</option>
      </select>
      {isOther && (
        <input
          aria-label={`${label}（自由入力）`}
          value={value}
          maxLength={20}
          placeholder="例: ppm"
          onChange={(event) => emit(event.target.value)}
          className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
        />
      )}
    </span>
  );
}
