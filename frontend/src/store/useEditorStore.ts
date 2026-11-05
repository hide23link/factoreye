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

import { NARROW_VIEWPORT } from "../lib/panel-placement";
import {
  loadWindowPosition,
  loadWindowSize,
  saveWindowPosition,
  saveWindowSize,
  type MovableWindow,
  type WindowPosition,
  type WindowSize,
} from "../lib/window-position";
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

// センサー棚を最初から開く画面の幅（px）。これより狭いと、棚がキャンバスの大部分を隠すため、閉じておく
export const SHELF_OPEN_MIN_WIDTH = 1600;

interface EditorState {
  editing: boolean;
  selectedWidgetId: string | null;
  // 左のセンサー棚・右の設定パネル・ウィジェットの部品バー（どれもキャンバスの上に重ねて出し、閉じられる）
  shelfOpen: boolean;
  // センサー棚（動かせる窓）の位置。null は既定の場所（左上に固定）。保存は localStorage
  shelfPos: WindowPosition | null;
  // 設定パネル（動かせる窓）の位置。null は自動配置（選んだウィジェットと棚を避ける）。保存は localStorage
  panelPos: WindowPosition | null;
  // 棚・パネルの大きさ。null は既定の大きさ。位置を持つ窓にだけある（位置を null に戻すと、大きさも null になる）。保存は localStorage
  shelfSize: WindowSize | null;
  panelSize: WindowSize | null;
  // 棚をつかんで動かしている最中か（その間は、設定パネルのためのスクロールをしない）
  shelfMoving: boolean;
  setShelfMoving: (moving: boolean) => void;
  panelOpen: boolean;
  partsOpen: boolean;
  // 設定パネルのダッシュボード名の入力欄に、フォーカスを移す（新しく作った直後に、名前をすぐ付けられるように）
  focusName: boolean;
  dragging: DragPayload | null;
  history: Widget[][];
  toast: EditorToast | null;
  startEditing: (options?: { focusName?: boolean }) => void;
  clearFocusName: () => void;
  stopEditing: () => void;
  /** ウィジェットを選ぶ（強調するだけ。設定パネルは開かない） */
  select: (id: string | null) => void;
  /** ウィジェットを選び、その設定パネルを開く（ウィジェット内の設定ボタン） */
  openSettings: (id: string) => void;
  setShelfOpen: (open: boolean) => void;
  /** 棚の位置を変える。persist=false は移動の途中（保存は、動かし終えたときに 1 回） */
  setShelfPos: (pos: WindowPosition | null, options?: { persist?: boolean }) => void;
  setPanelPos: (pos: WindowPosition | null, options?: { persist?: boolean }) => void;
  /** 棚・パネルの大きさを変える。persist=false は大きさを変えている途中（保存は、終えたときに 1 回） */
  setShelfSize: (size: WindowSize | null, options?: { persist?: boolean }) => void;
  setPanelSize: (size: WindowSize | null, options?: { persist?: boolean }) => void;
  setPanelOpen: (open: boolean) => void;
  setPartsOpen: (open: boolean) => void;
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

/** 保存した窓の位置と大きさを読む。大きさは位置を持つ窓にだけあるので、位置を復元できなければ大きさも使わない */
function loadWindowBox(kind: MovableWindow): { pos: WindowPosition | null; size: WindowSize | null } {
  if (typeof window === "undefined") return { pos: null, size: null };
  const pos = loadWindowPosition(kind, window.innerWidth, window.innerHeight);
  return { pos, size: pos ? loadWindowSize(kind) : null };
}

const isNarrow = () => typeof window !== "undefined" && window.innerWidth < NARROW_VIEWPORT;

export const useEditorStore = create<EditorState>((set, get) => ({
  editing: false,
  selectedWidgetId: null,
  shelfOpen: false,
  shelfPos: null,
  panelPos: null,
  shelfSize: null,
  panelSize: null,
  shelfMoving: false,
  setShelfMoving: (moving) => set({ shelfMoving: moving }),
  panelOpen: false,
  partsOpen: false,
  focusName: false,
  dragging: null,
  history: [],
  toast: null,
  // 広い画面（1024px 以上）では、センサー棚を最初から出す。狭い画面では、キャンバスを隠さないよう閉じておく
  startEditing: (options) => {
    const shelfWindow = loadWindowBox("shelf");
    const panelWindow = loadWindowBox("panel");
    set({
      editing: true,
      selectedWidgetId: null,
      shelfOpen: typeof window !== "undefined" && window.innerWidth >= SHELF_OPEN_MIN_WIDTH && !options?.focusName,
      // 名前を付けるときは、設定パネルを開く（棚は閉じて、キャンバスを隠さない）
      // 前回動かした棚・パネルの位置と大きさを復元する（保存が無い・いまの画面の外なら、既定の場所・大きさ）
      shelfPos: shelfWindow.pos,
      shelfSize: shelfWindow.size,
      panelPos: panelWindow.pos,
      panelSize: panelWindow.size,
      panelOpen: options?.focusName === true,
      partsOpen: false,
      focusName: options?.focusName === true,
    });
  },
  clearFocusName: () => set({ focusName: false }),
  stopEditing: () =>
    set({
      editing: false,
      selectedWidgetId: null,
      shelfOpen: false,
      panelOpen: false,
      partsOpen: false,
      dragging: null,
      history: [],
      toast: null,
    }),
  // 選ぶだけでは、設定パネルは開かない（ウィジェット内の設定ボタンで開く）。すでに開いていれば、選んだものの設定に切り替わる
  select: (id) => set(id === null ? { selectedWidgetId: null } : { selectedWidgetId: id, focusName: false }),
  // 狭い画面では、棚とパネルの両方を開くと、キャンバスが見えなくなるので、片方だけにする
  openSettings: (id) =>
    set((s) => ({ selectedWidgetId: id, panelOpen: true, focusName: false, shelfOpen: isNarrow() ? false : s.shelfOpen })),
  setShelfOpen: (open) => set((s) => ({ shelfOpen: open, panelOpen: open && isNarrow() ? false : s.panelOpen })),
  // 位置を null（既定の場所）に戻すときは、大きさも一緒に既定へ戻す
  setShelfPos: (pos, options) => {
    set(pos === null ? { shelfPos: null, shelfSize: null } : { shelfPos: pos });
    if (options?.persist === false) return;
    saveWindowPosition("shelf", pos);
    if (pos === null) saveWindowSize("shelf", null);
  },
  setPanelPos: (pos, options) => {
    set(pos === null ? { panelPos: null, panelSize: null } : { panelPos: pos });
    if (options?.persist === false) return;
    saveWindowPosition("panel", pos);
    if (pos === null) saveWindowSize("panel", null);
  },
  setShelfSize: (size, options) => {
    set({ shelfSize: size });
    if (options?.persist !== false) saveWindowSize("shelf", size);
  },
  setPanelSize: (size, options) => {
    set({ panelSize: size });
    if (options?.persist !== false) saveWindowSize("panel", size);
  },
  setPanelOpen: (open) => set((s) => ({ panelOpen: open, shelfOpen: open && isNarrow() ? false : s.shelfOpen })),
  setPartsOpen: (open) => set({ partsOpen: open }),
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
    set({
      editing: false,
      selectedWidgetId: null,
      shelfOpen: false,
      shelfPos: null,
      panelPos: null,
      shelfSize: null,
      panelSize: null,
      panelOpen: false,
      partsOpen: false,
      focusName: false,
      dragging: null,
      history: [],
      toast: null,
    }),
}));
