/**
 * 計器グラフ（TrendStackWidget）のカーソルが指している時刻と、その時刻の各センサーの値を、
 * 同じ画面の別のウィジェット（警報の欄の下の「カーソルの時刻の値」）に渡すための置き場。
 * 計器グラフが 2 つ以上あっても混ざらないよう、計器グラフ（ウィジェット）の ID ごとに持つ。
 * 警報の欄は、最初に書き込んだ計器グラフのものを出す（first）。計器グラフが無い画面では、何も無い（警報の欄は何も足さない）。
 *
 * 【誰が使うか】TrendStackWidget の本体（時刻を書く）と行（その行の値を書く）、AlarmAlertWidget（first を読む）。
 * 例: widgets = { w1: { time: 1763400000000, spanMs: 3600000, rows: [{ id: "s1", order: 0, name: "リビング 温度", unit: "℃", value: "20.0", color: "var(--fe-ink)" }] } }
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
  /** 値に添える注記（カーソルが警報の帯の中にあるときの「警報 11:42〜12:58 最高 89.2」など）。無ければ省く */
  notes?: Array<{ text: string; color: string }>;
}

/** 1 つの計器グラフのカーソル。spanMs は表示範囲の長さ（ミリ秒。時刻の文字に日付を付けるかを決める） */
export interface TrendCursorEntry {
  time: number;
  spanMs: number;
  rows: TrendCursorRow[];
}

interface TrendCursorState {
  /** 計器グラフ（ウィジェット ID）ごとのカーソル。キーは最初に書き込んだ順 */
  widgets: Record<string, TrendCursorEntry>;
  setCursor: (widgetId: string, time: number, spanMs: number) => void;
  /** 行の値を入れる。同じ内容なら入れ直さない（描き直しが続かないように） */
  setRow: (widgetId: string, row: TrendCursorRow) => void;
  removeRow: (widgetId: string, rowId: string) => void;
  /** その計器グラフ 1 つだけを取り下げる（消えた計器グラフが、ほかの計器グラフの分を消さないように） */
  clear: (widgetId: string) => void;
  /** すべて取り下げる（試験用） */
  clearAll: () => void;
}

/** 警報の欄に出す計器グラフのカーソル（最初に書き込んだもの）。無ければ undefined */
export function firstTrendCursor(widgets: Record<string, TrendCursorEntry>): TrendCursorEntry | undefined {
  return Object.values(widgets)[0];
}

export const useTrendCursorStore = create<TrendCursorState>((set) => ({
  widgets: {},
  setCursor: (widgetId, time, spanMs) =>
    set((state) => {
      const entry = state.widgets[widgetId];
      if (entry && entry.time === time && entry.spanMs === spanMs) return state;
      return { widgets: { ...state.widgets, [widgetId]: { rows: entry?.rows ?? [], time, spanMs } } };
    }),
  setRow: (widgetId, row) =>
    set((state) => {
      const entry = state.widgets[widgetId] ?? { time: 0, spanMs: 0, rows: [] };
      const same = entry.rows.find((r) => r.id === row.id);
      if (same && same.order === row.order && same.name === row.name && same.unit === row.unit && same.value === row.value && same.color === row.color && JSON.stringify(same.notes ?? []) === JSON.stringify(row.notes ?? [])) {
        return state;
      }
      const rows = [...entry.rows.filter((r) => r.id !== row.id), row].sort((a, b) => a.order - b.order);
      return { widgets: { ...state.widgets, [widgetId]: { ...entry, rows } } };
    }),
  removeRow: (widgetId, rowId) =>
    set((state) => {
      const entry = state.widgets[widgetId];
      if (!entry) return state;
      return { widgets: { ...state.widgets, [widgetId]: { ...entry, rows: entry.rows.filter((r) => r.id !== rowId) } } };
    }),
  clear: (widgetId) =>
    set((state) => {
      if (!(widgetId in state.widgets)) return state;
      const rest = { ...state.widgets };
      delete rest[widgetId];
      return { widgets: rest };
    }),
  clearAll: () => set({ widgets: {} }),
}));
