/**
 * 単位の選択欄。プルダウンで候補（lib/units.ts）を全部選べ、「その他」を選ぶと自由に入力できる。
 *
 * <input list> + <datalist> は、入力済みの値で候補が絞り込まれ、初期値の「°C」だけしか出なくなるため使わない。
 * 候補に無い既存の単位は、「その他」の入力欄にそのまま表示し、そのまま保存できる。
 *
 * 【誰が使うか】SensorSettingsPanel（作成フォーム・編集行）、SetupWizard。
 * 【引数（props）】value = 今の単位、onChange = 変えたとき、label = 読み上げ用の名前、className = 外側の幅など。
 */
import { useEffect, useState } from "react";

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
  // 「その他」を選んだ（まだ何も入力していない間も、入力欄を出し続ける）
  const [pickedOther, setPickedOther] = useState(false);
  // 値が入っているときは、値で決める（候補なら候補、そうでなければ「その他」）。空のときだけ、選んだ操作に従う
  const isOther = value !== "" ? !isPresetUnit(value) : pickedOther;
  // 親が単位を初期値（候補）に戻したときは、「その他」の選択も解く（作成後に、前回の状態が残らないように）
  useEffect(() => {
    if (isPresetUnit(value)) setPickedOther(false);
  }, [value]);
  const selected = isOther ? OTHER_UNIT : value;

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
            if (isPresetUnit(value)) onChange("");
            return;
          }
          setPickedOther(false);
          onChange(next);
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
          onChange={(event) => onChange(event.target.value)}
          className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
        />
      )}
    </span>
  );
}
