import { create } from "zustand";

// 管理者トークンはメモリ上のみ保持する（localStorage には保存しない）。
// ページを閉じる・再読み込みするとログインし直しになる。
interface AdminAuthState {
  token: string | null;
  setToken: (token: string) => void;
  clearToken: () => void;
}

export const useAdminStore = create<AdminAuthState>((set) => ({
  token: null,
  setToken: (token) => set({ token }),
  clearToken: () => set({ token: null }),
}));
