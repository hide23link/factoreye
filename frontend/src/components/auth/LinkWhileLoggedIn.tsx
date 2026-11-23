/**
 * すでにログインしているブラウザで、メールのリンク（登録・端末の再登録・ログイン）を開いたときの確認画面。
 *
 * リンクの処理（パスキーの登録・ログイン）は、今のログインとは別のアカウントのためのことが多い。
 * そのまま進めると、今のアカウントのログインと混ざるので、先にこの画面で確認する。
 * - 「続ける」: 今のログインを終了して、リンクの処理に進む（呼ぶ側が、ログインを終了する）
 * - 「やめる」: リンクを開かずに、今の画面（ダッシュボード）に戻る
 * リンクを開いただけでは、何も終わらない（トークンも、ここでは使わない）。
 *
 * 【誰が使うか】App.tsx が、ログイン中に URL の # にリンクがあるときだけ出す。
 * 【引数（props）】kind=リンクの種類、currentEmail=今ログインしているアドレス、
 * onContinue=続けるとき、onCancel=やめるとき。
 */
import type { AuthLinkKind } from "../../lib/auth-link";

interface LinkWhileLoggedInProps {
  kind: AuthLinkKind;
  currentEmail: string;
  onContinue: () => void;
  onCancel: () => void;
}

const KIND_LABEL: Record<AuthLinkKind, string> = {
  register: "新規登録のリンク",
  recover: "端末の再登録のリンク",
  login: "ログインのリンク",
};

export function LinkWhileLoggedIn({ kind, currentEmail, onContinue, onCancel }: LinkWhileLoggedInProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div
        role="dialog"
        aria-label="メールのリンクを開こうとしています"
        className="w-full max-w-md space-y-4 rounded-xl bg-white px-8 py-8 shadow-sm ring-1 ring-gray-200"
      >
        <h1 className="text-lg font-bold text-gray-900">メールのリンクを開こうとしています</h1>
        <p className="text-sm text-gray-700">
          これは<b>{KIND_LABEL[kind]}</b>です。今は <span className="font-mono">{currentEmail}</span>{" "}
          でログイン中です。
        </p>
        <p className="text-sm text-gray-700">
          続けると、<b>今のログインを終了</b>して、リンクの処理に進みます。別のアカウントのリンクなら、続けてください。
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            やめる（今のまま使う）
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            続ける（今のログインを終了）
          </button>
        </div>
      </div>
    </div>
  );
}
