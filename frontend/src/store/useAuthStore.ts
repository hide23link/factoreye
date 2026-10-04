/**
 * ログインの状態（SaaS 版のみ使う）。
 *
 * - アクセストークン: API の呼び出しに付ける。メモリ（この状態）にだけ置く
 * - リフレッシュトークン: 再ログインなしで復元するため、localStorage に保存する
 *   （使えない環境では保存しない。その場合、再読み込みでログインが必要になる）
 */
import { create } from "zustand";

import type { MeResponse } from "../types";

// localStorage に保存するときの鍵の名前
const REFRESH_TOKEN_KEY = "factoreye_rt";

interface AuthState {
  accessToken: string | null;
  me: MeResponse | null;
  /** ページ初回ロード時のリフレッシュ試行中 */
  isInitializing: boolean;

  /** ログイン成功時: トークンと利用者の情報を入れる。 */
  setAuth: (accessToken: string, refreshToken: string, me: MeResponse) => void;
  /** リフレッシュ後: me はそのまま、トークンだけ更新 */
  updateTokens: (accessToken: string, refreshToken: string) => void;
  clearAuth: () => void;
  setInitializing: (v: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  me: null,
  isInitializing: true,

  setAuth: (accessToken, refreshToken, me) => {
    // localStorage が使えない環境（プライベートブラウズ等）は無視
    try { localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken); } catch { /* noop */ }
    set({ accessToken, me, isInitializing: false });
  },

  updateTokens: (accessToken, refreshToken) => {
    try { localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken); } catch { /* noop */ }
    set({ accessToken });
  },

  clearAuth: () => {
    try { localStorage.removeItem(REFRESH_TOKEN_KEY); } catch { /* noop */ }
    set({ accessToken: null, me: null, isInitializing: false });
  },

  setInitializing: (v) => set({ isInitializing: v }),
}));

/** 保存されているリフレッシュトークンを返す。無い・読めない場合は null。 */
export function getStoredRefreshToken(): string | null {
  try { return localStorage.getItem(REFRESH_TOKEN_KEY); } catch { return null; }
}
