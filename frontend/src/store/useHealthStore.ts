import { create } from "zustand";

import { fetchHealth, type HealthResponse } from "../lib/api";

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
