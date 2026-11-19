/**
 * 画面全体の更新間隔の選択（Zustand）。この端末のブラウザ（localStorage）に覚える。
 * 既定は「各グラフの設定に従う」（何も上書きしない）。
 *
 * 【誰が使うか】hooks/queries.ts（グラフの取り直し間隔）、TimeRangeControls（選択の変更）。
 * キオスク（画面表示モード）も同じ値で動く。
 */
import { create } from "zustand";

import { DEFAULT_REFRESH_CHOICE, sanitizeRefreshChoice, type RefreshChoice } from "../lib/refresh-interval";

const STORAGE_KEY = "factoreye.refreshInterval";

// ビルド時に決まる動作モード（SaaS では 10 秒を選べない）
const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

interface RefreshState {
  choice: RefreshChoice;
  /** 選択を変える。localStorage にも書く（使えない環境では無視） */
  setChoice: (choice: RefreshChoice) => void;
}

function read(): RefreshChoice {
  try {
    return sanitizeRefreshChoice(localStorage.getItem(STORAGE_KEY), IS_MULTI_TENANT);
  } catch {
    return DEFAULT_REFRESH_CHOICE;
  }
}

export const useRefreshStore = create<RefreshState>()((set) => ({
  choice: read(),
  setChoice: (choice) => {
    set({ choice });
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // 保存できなくても、この画面の間は選択が効く
    }
  },
}));
