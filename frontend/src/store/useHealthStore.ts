/**
 * バックエンドの接続状態（/health の結果）を持つストア。
 * 画面の上部の表示（HealthBadge）が、この値を読む。
 */
import { create } from "zustand";

import { fetchHealth, type HealthResponse } from "../lib/api";

/** 接続状態（最後の応答、エラー、確認中かどうか）と、確かめ直す関数。 */
interface HealthState {
  health: HealthResponse | null;
  error: string | null;
  loading: boolean;
  check: () => Promise<void>;
}

export const useHealthStore = create<HealthState>((set) => ({
  health: null,
  error: null,
  loading: false,
  // バックエンドの /health を呼んで、結果かエラーを記録する
  check: async () => {
    set({ loading: true, error: null });
    try {
      const health = await fetchHealth();
      set({ health, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "unknown error", loading: false });
    }
  },
}));
