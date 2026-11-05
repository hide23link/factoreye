/**
 * 管理者が利用者として閲覧するときの情報（SaaS 版のみ）。
 *
 * - 管理画面（別のタブ）が、トークンを sessionStorage に入れてから新しいタブを開く。
 *   新しいタブは、開いた時点の sessionStorage の写しを受け取るので、そこから読む
 * - 期限（短い）を過ぎたものは使わない。リフレッシュトークンは扱わない
 * - 利用者本人のログイン（localStorage のリフレッシュトークン）とは、別の鍵で保存する
 *
 * 【誰が使うか】App.tsx（読む）、AdminUserModal.tsx（書く）、useAuthStore.ts。
 */

const KEY = "factoreye_impersonation";

export interface ImpersonationInfo {
  accessToken: string;
  email: string;
  workspaceName: string;
  /** 期限（ミリ秒の Unix 時刻） */
  expiresAt: number;
}

/** 閲覧の情報を保存する（管理画面のタブから呼ぶ） */
export function saveImpersonation(info: ImpersonationInfo): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(info));
  } catch {
    // 保存できない環境では、閲覧は始められない（呼び出し側で案内する）
  }
}

/** 保存されている閲覧の情報を読む。無い・期限切れ・壊れている場合は null（期限切れのものは消す） */
export function readImpersonation(now: number = Date.now()): ImpersonationInfo | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const info = JSON.parse(raw) as ImpersonationInfo;
    if (!info.accessToken || typeof info.expiresAt !== "number") {
      clearImpersonation();
      return null;
    }
    if (info.expiresAt <= now) {
      clearImpersonation();
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

/** 閲覧の情報を消す（閲覧を終えるとき・期限切れのとき） */
export function clearImpersonation(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 消せなくても、期限で使われなくなる
  }
}
