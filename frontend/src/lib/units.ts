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
  { value: "hPa", hint: "気圧・ヘクトパスカル" },
  { value: "dBm", hint: "電波の強さ" },
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
  { value: "0/1", hint: "稼働（動いている=1）" },
  { value: "mA", hint: "電流" },
  { value: "ppm", hint: "濃度" },
  { value: "dB", hint: "騒音" },
  { value: "s", hint: "時間（秒）" },
  { value: "min", hint: "時間（分）" },
];

/** 選択欄で「その他（自由入力）」を表す値。単位として保存されることはない */
export const OTHER_UNIT = "__other__";

export function isPresetUnit(unit: string): boolean {
  return UNIT_PRESETS.some((p) => p.value === unit);
}

/** サーバーが「単位なし」を表すのに使う仮の単位（単位は 1 文字以上が必須。機器が自動登録したセンサーはこれになる） */
export const PLACEHOLDER_UNIT = "-";

/** 名前・キーに含まれる言葉から、単位を決める規則（上から順に最初に合ったもの）。小文字にして比べる */
const UNIT_RULES: ReadonlyArray<{ pattern: RegExp; unit: string }> = [
  { pattern: /rssi|電波/, unit: "dBm" },
  { pattern: /uptime|稼働時間/, unit: "s" },
  { pattern: /humi|humidity|湿度/, unit: "%" },
  { pattern: /press|気圧/, unit: "hPa" },
  { pattern: /temp|温度/, unit: "°C" },
  { pattern: /co2/, unit: "ppm" },
  { pattern: /sendfail|wifidc|reset|送信失敗/, unit: "回" },
  { pattern: /batt|電池|電圧|volt/, unit: "V" },
];

/**
 * センサーの単位を、画面に出す形にそろえる。
 * 単位が「-」か空なら、名前とキーから決める（例: "atom01-humi" → "%"）。決められなければ空（数字だけ出す）。
 * 例: normalizeUnit("-", "atom01-temp", "atom01-temp") → "°C"、normalizeUnit("-", "atom01-heartbeat", "") → ""、normalizeUnit("ppm", …) → "ppm"
 */
export function normalizeUnit(unit: string, name: string, ingestKey: string): string {
  const trimmed = unit.trim();
  if (trimmed !== "" && trimmed !== PLACEHOLDER_UNIT) return unit;
  const text = `${name} ${ingestKey}`.toLowerCase();
  return UNIT_RULES.find((rule) => rule.pattern.test(text))?.unit ?? "";
}

/** サーバーへ送る単位。空は「-」にする（サーバーは 1 文字以上が必須） */
export function unitForServer(unit: string): string {
  const trimmed = unit.trim();
  return trimmed === "" ? PLACEHOLDER_UNIT : trimmed;
}
