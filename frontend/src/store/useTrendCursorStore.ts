/**
 * 計器グラフ（TrendStackWidget）のカーソルが指している時刻と、その時刻の各センサーの値を、
 * 同じ画面の別のウィジェット（警報の欄の下の「カーソルの時刻の値」）に渡すための置き場。
 * 計器グラフが無い画面では、rows が空のまま（警報の欄は何も足さない）。
 *
 * 【誰が使うか】TrendStackWidget の本体（時刻を書く）と行（その行の値を書く）、AlarmAlertWidget（読む）。
 * 例: time = 1763400000000、rows = [{ id: "s1", order: 0, name: "リビング 温度", unit: "℃", value: "20.0", color: "var(--fe-ink)" }]
 */
import { create } from "zustand";

/** 「カーソルの時刻の値」の 1 行。value は表示用の文字（データが無い時刻は「---」）。order は計器グラフの行の順 */
export interface TrendCursorRow {
  id: string;
  order: number;
  name: string;
  unit: string;
  value: string;
  color: string;
}

interface TrendCursorState {
  /** カーソルの時刻（ミリ秒）。計器グラフが無ければ null */
  time: number | null;
  /** 表示範囲の長さ（ミリ秒）。時刻の文字の形（日付を付けるか）を決める */
  spanMs: number;
  rows: TrendCursorRow[];
  setCursor: (time: number, spanMs: number) => void;
  /** 行の値を入れる。同じ内容なら入れ直さない（描き直しが続かないように） */
  setRow: (row: TrendCursorRow) => void;
  removeRow: (id: string) => void;
  clear: () => void;
}

export const useTrendCursorStore = create<TrendCursorState>((set) => ({
  time: null,
  spanMs: 0,
  rows: [],
  setCursor: (time, spanMs) => set((state) => (state.time === time && state.spanMs === spanMs ? state : { time, spanMs })),
  setRow: (row) =>
    set((state) => {
      const same = state.rows.find((r) => r.id === row.id);
      if (same && same.order === row.order && same.name === row.name && same.unit === row.unit && same.value === row.value && same.color === row.color) {
        return state;
      }
      return { rows: [...state.rows.filter((r) => r.id !== row.id), row].sort((a, b) => a.order - b.order) };
    }),
  removeRow: (id) => set((state) => ({ rows: state.rows.filter((r) => r.id !== id) })),
  clear: () => set({ time: null, spanMs: 0, rows: [] }),
}));
