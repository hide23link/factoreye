/**
 * ダッシュボードの編集画面の状態。
 * 編集中か、選んでいるウィジェット、棚のタブ、ドラッグ中のもの、元に戻すための履歴、画面下の通知。
 *
 * ウィジェットの枠・棚・設定パネル・格子が、離れた場所から同じ状態を読み書きするため、zustand に置く。
 * ダッシュボードを離れたら reset() で空に戻す（別のダッシュボードの履歴で「元に戻す」が働かないように）。
 *
 * 【誰が使うか】DashboardView、WidgetCard、EditorShelf、SettingsPanel、useWidgetActions。
 */
import { create } from "zustand";

import type { Widget } from "../types";

/** ドラッグしているもの: 棚のセンサー、または棚のウィジェットの種類 */
export type DragPayload =
  | { kind: "sensor"; sensorId: string }
  | { kind: "widgetType"; type: Widget["type"] };

export interface EditorToast {
  id: number;
  message: string;
  /** 通知につける操作（例: 元に戻す） */
  action?: { label: string; run: () => void };
}

/** 元に戻せる回数の上限 */
const HISTORY_LIMIT = 50;

interface EditorState {
  editing: boolean;
  selectedWidgetId: string | null;
  shelfTab: "sensor" | "widget";
  dragging: DragPayload | null;
  history: Widget[][];
  toast: EditorToast | null;
  startEditing: () => void;
  stopEditing: () => void;
  select: (id: string | null) => void;
  setShelfTab: (tab: "sensor" | "widget") => void;
  setDragging: (payload: DragPayload | null) => void;
  /** 操作の直前のウィジェット一覧を記録する */
  pushHistory: (snapshot: Widget[]) => void;
  /** 一番新しい記録を取り出す（無ければ null） */
  popHistory: () => Widget[] | null;
  /** 指定した記録だけを捨てる（失敗した操作の記録を消す。その間に別の記録が積まれていても、巻き込まない） */
  discardHistory: (snapshot: Widget[]) => void;
  showToast: (message: string, action?: EditorToast["action"]) => void;
  clearToast: () => void;
  reset: () => void;
}

let nextToastId = 1;

export const useEditorStore = create<EditorState>((set, get) => ({
  editing: false,
  selectedWidgetId: null,
  shelfTab: "sensor",
  dragging: null,
  history: [],
  toast: null,
  startEditing: () => set({ editing: true, selectedWidgetId: null }),
  stopEditing: () => set({ editing: false, selectedWidgetId: null, dragging: null, history: [], toast: null }),
  select: (id) => set({ selectedWidgetId: id }),
  setShelfTab: (tab) => set({ shelfTab: tab }),
  setDragging: (payload) => set({ dragging: payload }),
  pushHistory: (snapshot) => set((s) => ({ history: [...s.history, snapshot].slice(-HISTORY_LIMIT) })),
  popHistory: () => {
    const { history } = get();
    if (history.length === 0) return null;
    set({ history: history.slice(0, -1) });
    return history[history.length - 1];
  },
  discardHistory: (snapshot) => set((s) => ({ history: s.history.filter((h) => h !== snapshot) })),
  showToast: (message, action) => set({ toast: { id: nextToastId++, message, action } }),
  clearToast: () => set({ toast: null }),
  reset: () =>
    set({ editing: false, selectedWidgetId: null, shelfTab: "sensor", dragging: null, history: [], toast: null }),
}));
