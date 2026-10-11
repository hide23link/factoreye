/**
 * API の失敗を表す例外と、利用者向けの日本語の文言への変換。
 *
 * ApiError は、HTTP の状態コード（status）を持つ。画面は、メッセージの文字列ではなく status で判断する。
 * message は従来どおり「METHOD path failed: status 本文」の形（ログ・開発者向け。利用者には出さない）。
 */

/** API が失敗の状態コード（4xx / 5xx）で応答したときの例外。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** HTTP の状態コードを持つ失敗なら、その状態コードを返す。持たない（通信自体の失敗など）なら null。 */
export function errorStatus(err: unknown): number | null {
  if (err instanceof ApiError) return err.status;
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

/** 状態コードに共通の説明。個別の文言が無いものは、これを使う。 */
function commonMessage(status: number | null): string {
  if (status === null) return "サーバーに接続できませんでした。通信の状態を確認して、もう一度お試しください。";
  if (status === 429) return "試行回数が多すぎます。しばらく待ってから、もう一度お試しください。";
  if (status >= 500) return "サーバーで問題が起きました。しばらくしてから、もう一度お試しください。";
  return "処理に失敗しました。もう一度お試しください。";
}

/**
 * ログイン・新規登録の失敗を、利用者向けの文言にする。
 * 401（認証失敗）・409（登録済み）・422（入力の不備）・429（回数超過）・サーバーエラー・通信エラーを区別する。
 */
export function describeAuthError(err: unknown, kind: "login" | "register"): string {
  const status = errorStatus(err);
  if (status === 401) return "メールアドレスまたはパスワードが正しくありません。";
  if (status === 409) return "このメールアドレスは、すでに登録されています。";
  if (status === 422) {
    return kind === "register"
      ? "入力内容を確認してください（メールアドレスの形式、パスワードは8文字以上）。"
      : "メールアドレスの形式を確認してください。";
  }
  return commonMessage(status);
}

/** 管理者ログインの失敗を、利用者向けの文言にする（401 だけが「ID またはパスワードの誤り」）。 */
export function describeAdminLoginError(err: unknown): string {
  const status = errorStatus(err);
  if (status === 401) return "IDまたはパスワードが正しくありません。";
  return commonMessage(status);
}

/** 保存・削除などの操作の失敗を、利用者向けの文言にする。action は「ウィジェットの削除」のような操作名。 */
export function describeActionError(err: unknown, action: string): string {
  const status = errorStatus(err);
  if (status === 401) return `${action}に失敗しました。ログインし直してください。`;
  if (status === 404) return `${action}に失敗しました。すでに削除されている可能性があります。画面を読み込み直してください。`;
  if (status === null) return `${action}に失敗しました。サーバーに接続できませんでした。`;
  if (status >= 500) return `${action}に失敗しました。サーバーで問題が起きました。`;
  return `${action}に失敗しました。`;
}
