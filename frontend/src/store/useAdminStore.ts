import { create } from "zustand";

// 管理者トークンは sessionStorage に保存する。
// - 再読み込みしてもログインを保ったままになる（タブを閉じると消える）
// - localStorage は使わない（ブラウザを閉じても残るため）
// - トークンは 60 分で失効し、期限切れはサーバーが拒否する（画面は再ログインへ戻す）
const STORAGE_KEY = "factoreye_admin_token";

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // sessionStorage が使えない環境（プライベートブラウズ等）はメモリだけで動かす
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // 保存できなくても、この画面の中では動く
  }
}

interface AdminAuthState {
  token: string | null;
  setToken: (token: string) => void;
  clearToken: () => void;
}

export const useAdminStore = create<AdminAuthState>((set) => ({
  token: readStoredToken(),
  setToken: (token) => {
    writeStoredToken(token);
    set({ token });
  },
  clearToken: () => {
    writeStoredToken(null);
    set({ token: null });
  },
}));
