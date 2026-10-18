/**
 * 管理者画面（/admin）のログイン状態。
 *
 * 管理者トークンは sessionStorage に保存する。
 * - 再読み込みしてもログインを保ったままになる（タブを閉じると消える）
 * - localStorage は使わない（ブラウザを閉じても残るため）
 * - トークンは 60 分で失効し、期限切れはサーバーが拒否する（画面は再ログインへ戻す）
 *
 * 【誰が使うか】AdminApp.tsx と AdminLoginPage.tsx。
 */
import { create } from "zustand";

// sessionStorage に保存するときの鍵の名前
const STORAGE_KEY = "factoreye_admin_token";

/** 保存されている管理者トークンを読む（無い・読めない場合は null）。 */
function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // sessionStorage が使えない環境（プライベートブラウズ等）はメモリだけで動かす
    return null;
  }
}

/** 管理者トークンを保存する（null なら削除）。保存できなくても例外は出さない。 */
function writeStoredToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // 保存できなくても、この画面の中では動く
  }
}

/** 管理者のログイン状態（トークンを持つ・消す）。 */
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
