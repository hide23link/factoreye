/**
 * センサーの単位の候補（現場でよく使うもの）。選択欄（UnitSelect）に並べる。
 * 候補に無い単位は「その他」で自由に入力できる。
 *
 * 【誰が使うか】UnitSelect（センサー設定・セットアップガイド）。
 */
export interface UnitPreset {
  value: string;
  /** 何の量か（選ぶときの目印） */
  hint: string;
}

export const UNIT_PRESETS: readonly UnitPreset[] = [
  { value: "°C", hint: "温度" },
  { value: "%", hint: "湿度・割合" },
  { value: "MPa", hint: "圧力" },
  { value: "kPa", hint: "圧力" },
  { value: "Pa", hint: "圧力" },
  { value: "bar", hint: "圧力" },
  { value: "kW", hint: "電力" },
  { value: "W", hint: "電力" },
  { value: "kWh", hint: "電力量" },
  { value: "A", hint: "電流" },
  { value: "V", hint: "電圧" },
  { value: "Hz", hint: "周波数" },
  { value: "mm/s", hint: "振動" },
  { value: "m/s²", hint: "振動（加速度）" },
  { value: "L/min", hint: "流量" },
  { value: "m³/h", hint: "流量" },
  { value: "rpm", hint: "回転数" },
  { value: "mm", hint: "長さ・変位" },
  { value: "kg", hint: "重さ" },
  { value: "L", hint: "容量" },
  { value: "個", hint: "生産数" },
  { value: "台", hint: "生産数" },
  { value: "本", hint: "生産数" },
  { value: "枚", hint: "生産数" },
  { value: "回", hint: "回数" },
];

/** 選択欄で「その他（自由入力）」を表す値。単位として保存されることはない */
export const OTHER_UNIT = "__other__";

export function isPresetUnit(unit: string): boolean {
  return UNIT_PRESETS.some((p) => p.value === unit);
}
