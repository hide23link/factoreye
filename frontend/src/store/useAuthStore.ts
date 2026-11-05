/**
 * ログインの状態（SaaS 版のみ使う）。
 *
 * - アクセストークン: API の呼び出しに付ける。メモリ（この状態）にだけ置く
 * - リフレッシュトークン: 再ログインなしで復元するため、localStorage に保存する
 *   （使えない環境では保存しない。その場合、再読み込みでログインが必要になる）
 * - 管理者が利用者として閲覧中（impersonation）: 利用者のトークンだけを使い、
 *   リフレッシュトークンには触らない（閲覧を終えても、利用者本人のログインを消さないため）
 *
 * 【誰が使うか】App.tsx、LoginPage.tsx、lib/api.ts（通信にトークンを付ける）。
 */
import { create } from "zustand";

import { clearImpersonation, type ImpersonationInfo } from "../lib/impersonation";
import type { MeResponse } from "../types";

// localStorage に保存するときの鍵の名前
const REFRESH_TOKEN_KEY = "factoreye_rt";

interface AuthState {
  accessToken: string | null;
  me: MeResponse | null;
  /** ページ初回ロード時のリフレッシュ試行中 */
  isInitializing: boolean;
  /** 管理者が利用者として閲覧中の情報。通常のログイン中は null */
  impersonation: ImpersonationInfo | null;

  /** ログイン成功時: トークンと利用者の情報を入れる。 */
  setAuth: (accessToken: string, refreshToken: string, me: MeResponse) => void;
  /** 管理者の閲覧を始める: 利用者のトークンと情報を入れる（リフレッシュトークンは保存しない） */
  setImpersonated: (info: ImpersonationInfo, me: MeResponse) => void;
  /** リフレッシュ後: me はそのまま、トークンだけ更新 */
  updateTokens: (accessToken: string, refreshToken: string) => void;
  clearAuth: () => void;
  setInitializing: (v: boolean) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  me: null,
  isInitializing: true,
  impersonation: null,

  setAuth: (accessToken, refreshToken, me) => {
    // localStorage が使えない環境（プライベートブラウズ等）は無視
    try { localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken); } catch { /* noop */ }
    set({ accessToken, me, isInitializing: false, impersonation: null });
  },

  setImpersonated: (info, me) => {
    set({ accessToken: info.accessToken, me, isInitializing: false, impersonation: info });
  },

  updateTokens: (accessToken, refreshToken) => {
    try { localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken); } catch { /* noop */ }
    set({ accessToken });
  },

  clearAuth: () => {
    // 閲覧中は、利用者本人のリフレッシュトークン（localStorage）に触れない
    if (get().impersonation) {
      clearImpersonation();
    } else {
      try { localStorage.removeItem(REFRESH_TOKEN_KEY); } catch { /* noop */ }
    }
    set({ accessToken: null, me: null, isInitializing: false, impersonation: null });
  },

  setInitializing: (v) => set({ isInitializing: v }),
}));

/** 保存されているリフレッシュトークンを返す。無い・読めない場合は null。 */
export function getStoredRefreshToken(): string | null {
  try { return localStorage.getItem(REFRESH_TOKEN_KEY); } catch { return null; }
}
