/**
 * メールのリンク（登録・端末の再登録・ログイン）の、URL の # 以降を読む。
 *
 * リンクは `https://（サイト）/#register=トークン`（登録）、`#recover=トークン`（端末の再登録）、
 * `#login=トークン`（ログインリンク）の形。トークンを # のあとに置くのは、サーバーのアクセスログ・
 * 中継に残さないため（# 以降は、ブラウザからサーバーへ送られない）。
 *
 * 【誰が使うか】components/auth/LoginPage.tsx（リンクで開かれたときの画面の切り替え）。
 */

/** リンクの種類。 */
export type AuthLinkKind = "register" | "recover" | "login";

export interface AuthLink {
  kind: AuthLinkKind;
  token: string;
}

/** `#register=…` などの文字列から、リンクの種類とトークンを取り出す。リンクでなければ null。 */
export function parseAuthLinkHash(hash: string): AuthLink | null {
  const found = /^#(register|recover|login)=([A-Za-z0-9_-]{10,200})$/.exec(hash);
  if (!found) return null;
  return { kind: found[1] as AuthLinkKind, token: found[2] };
}

/** 使い終えたリンクのトークンを、アドレスバー・履歴から消す（画面を再読み込みしても使われない）。 */
export function clearAuthLinkFromUrl(): void {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
