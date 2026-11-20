/**
 * 複数センサー比較グラフの下に出す「凡例の表」の計算。画面の部品（LegendTable）から切り出して、数値だけを試せるようにしている。
 * 表の数値は、線を描くのと同じ取得データ（区間の max・min・avg と、時刻ごとの行）から計算する。
 *
 * - valueAtCursor: カーソルがある時刻の値（その時刻に近い行から選ぶ。遠すぎれば値なし）
 * - toggleSelection: 行をクリックしたときの「表示するセンサー」の選び直し
 * - isDimmed: 線を薄くするかどうか
 *
 * 【誰が使うか】MultiSensorComparisonWidget（線の薄め方）、LegendTable（表の値・行の操作）。
 */
import type { GraphRow } from "./graph-series";

/**
 * カーソルの時刻の、そのセンサーの値。そのセンサーの値がある行のうち、時刻にいちばん近い行を選び、
 * 時刻の差が toleranceMs 以内ならその値を返す。遠すぎる・値のある行が無ければ undefined。
 * 呼び出し側は、実測のある行だけ（積み上げの埋め草を含まない行）を渡す。
 * 例: rows = [{ time: 1000, a: 5 }, { time: 2000, a: 7 }] のとき、valueAtCursor(rows, "a", 1900, 300) → 7、valueAtCursor(rows, "a", 5000, 300) → undefined
 */
export function valueAtCursor(
  rows: ReadonlyArray<GraphRow>,
  sensorId: string,
  at: number,
  toleranceMs: number,
): number | undefined {
  let best: { value: number; gap: number } | undefined;
  for (const row of rows) {
    const value = row[sensorId];
    if (value === undefined) continue;
    const gap = Math.abs(row.time - at);
    if (!best || gap < best.gap) best = { value, gap };
  }
  return best && best.gap <= toleranceMs ? best.value : undefined;
}

/**
 * 値の列に使うカーソルの時刻。共有の時刻が、このグラフの表示範囲（from〜to）の中にあるときだけ返す。
 * 無い・範囲の外なら null（そのときの表は「最新」の値を出す）。
 * 例: tableCursorTime(500, 0, 1000) → 500、tableCursorTime(2000, 0, 1000) → null、tableCursorTime(null, 0, 1000) → null
 */
export function tableCursorTime(time: number | null, from: number, to: number): number | null {
  return time !== null && time >= from && time <= to ? time : null;
}

/**
 * 行をクリックしたあとの、表示するセンサー（選択）の一覧。空のときは「全部表示」の意味。
 * - 通常のクリック: すでにその 1 本だけが選ばれていれば解除（全部に戻る）。それ以外は、その 1 本だけにする。
 * - Shift・Ctrl・Cmd クリック（multi = true）: その 1 本を、選択に足す・外す（外して空になれば全部に戻る）。
 * 例: toggleSelection([], "a", false) → ["a"]、toggleSelection(["a"], "a", false) → []、toggleSelection(["a"], "b", true) → ["a", "b"]
 */
export function toggleSelection(selected: ReadonlyArray<string>, sensorId: string, multi: boolean): string[] {
  const isSelected = selected.includes(sensorId);
  if (multi) return isSelected ? selected.filter((id) => id !== sensorId) : [...selected, sensorId];
  return isSelected && selected.length === 1 ? [] : [sensorId];
}

/** 線を薄くするか。選択が空なら、どの線も薄くしない。選択があれば、選ばれていない線を薄くする */
export function isDimmed(selected: ReadonlyArray<string>, sensorId: string): boolean {
  return selected.length > 0 && !selected.includes(sensorId);
}
