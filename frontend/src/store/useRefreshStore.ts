/**
 * 画面全体の更新間隔の選択（Zustand）。既定は「各グラフの設定に従う」（何も上書きしない）。
 *
 * - 10 秒・1 分などの選択は、この端末のブラウザ（localStorage）に覚える
 * - Off（手動）は覚えない。再読み込みで既定に戻る（Off のまま放置して、更新が止まったままになるのを防ぐ）
 * - manualAt = 最後に「⟳」を押した（または選択を変えた）時刻。Off のとき、画面の「現在時刻」はこの時刻まで進む
 *
 * 【誰が使うか】hooks/queries.ts（取り直し間隔）、hooks/useLiveNow.ts（現在時刻）、RefreshControls（選択・⟳）、
 * useUiStore（キオスクに入るとき Off を戻す）。キオスク（画面表示モード）も同じ値で動く。
 */
import { create } from "zustand";

import { DEFAULT_REFRESH_CHOICE, sanitizeRefreshChoice, type RefreshChoice } from "../lib/refresh-interval";

const STORAGE_KEY = "factoreye.refreshInterval";

// ビルド時に決まる動作モード（SaaS では 10 秒を選べない）
const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

interface RefreshState {
  choice: RefreshChoice;
  manualAt: number;
  /** 選択を変える。Off 以外は localStorage にも書く（使えない環境では無視）。Off を選んだときは保存を既定に戻す */
  setChoice: (choice: RefreshChoice) => void;
  /** 画面の現在時刻を、今まで進める（⟳ を押したとき） */
  markManualRefresh: () => void;
  /** キオスクに入るとき: Off なら既定（各グラフの設定）に戻す */
  leaveOffForKiosk: () => void;
}

/** 保存した選択を読む。Off は保存しないので、読み込んでも既定にする */
function read(): RefreshChoice {
  try {
    const choice = sanitizeRefreshChoice(localStorage.getItem(STORAGE_KEY), IS_MULTI_TENANT);
    return choice === "off" ? DEFAULT_REFRESH_CHOICE : choice;
  } catch {
    return DEFAULT_REFRESH_CHOICE;
  }
}

function write(choice: RefreshChoice) {
  try {
    // Off は覚えず、保存を既定に戻す
    localStorage.setItem(STORAGE_KEY, choice === "off" ? DEFAULT_REFRESH_CHOICE : choice);
  } catch {
    // 保存できなくても、この画面の間は選択が効く
  }
}

export const useRefreshStore = create<RefreshState>()((set, get) => ({
  choice: read(),
  manualAt: 0,
  setChoice: (choice) => {
    set({ choice, manualAt: Date.now() });
    write(choice);
  },
  markManualRefresh: () => set({ manualAt: Date.now() }),
  leaveOffForKiosk: () => {
    if (get().choice === "off") get().setChoice(DEFAULT_REFRESH_CHOICE);
  },
}));
