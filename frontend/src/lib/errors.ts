/**
 * API の失敗を表す例外と、利用者向けの日本語の文言への変換。
 *
 * ApiError は、HTTP の状態コード（status）を持つ。画面は、メッセージの文字列ではなく status で判断する。
 * message は従来どおり「METHOD path failed: status 本文」の形（ログ・開発者向け。利用者には出さない）。
 *
 * 【誰が使うか】lib/api.ts（ApiError を投げる）と、エラーを画面に出す components/（文言への変換）。
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

/** サーバーが、メールの 1 日の送信数の上限に達したときに返す理由（503 の detail）。 */
const MAIL_BUSY_DETAIL = "mail is busy";
const MAIL_BUSY_MESSAGE = "現在メールの送信が混み合っています。しばらくしてからやり直してください。";

/** 認証の操作の種類（失敗の文言を、操作に合わせて変える）。 */
export type AuthAction = "login" | "register" | "request" | "link";

/**
 * パスキーでの登録・ログインと、メールのリンクの失敗を、利用者向けの文言にする。
 * 401（パスキーを確かめられない）・410（リンクの期限切れ・使用済み）・409（すでに登録済み）・
 * 429（回数超過）・503（メールを送れない設定、または 1 日の送信数の上限で混み合っている）・
 * サーバーエラー・通信エラーを区別する。
 */
export function describeAuthError(err: unknown, action: AuthAction): string {
  const status = errorStatus(err);
  if (status === 401) return "パスキーを確かめられませんでした。もう一度お試しください。";
  if (status === 410) {
    return action === "link"
      ? "このリンクは、期限が切れたか、すでに使われています。もう一度メールを送ってください。"
      : "リンクが使えません。もう一度メールを送ってください。";
  }
  if (status === 409) return "このメールアドレスまたはパスキーは、すでに登録されています。";
  if (status === 400) return "登録を確かめられませんでした。もう一度お試しください。";
  if (status === 422) return "メールアドレスの形式を確認してください。";
  if (status === 503 && action === "request") {
    // 1 日の送信数の上限（混み合っている）と、メールの設定がない（運用側の問題）を、本文の理由で分ける
    if (errorDetails(err).includes(MAIL_BUSY_DETAIL)) return MAIL_BUSY_MESSAGE;
    return "メールを送れない設定になっています。管理者に連絡してください。";
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

/**
 * センサーの作成・更新の失敗を、利用者向けの文言にする。
 * 409（名前や Ingest Key の重複）と 422（入力の不備）を区別し、ほかは操作の失敗の共通文言にする。
 */
export function describeSensorError(err: unknown, action: string): string {
  const status = errorStatus(err);
  if (status === 409) return `${action}に失敗しました。その名前（または Ingest Key）は、すでに使われています。`;
  if (status === 422) return `${action}に失敗しました。入力内容（名前・単位・しきい値）を確認してください。`;
  return describeActionError(err, action);
}

/**
 * API が返した失敗の理由（本文の detail）を、文字列の一覧にする。取り出せなければ空の一覧。
 * 設定ファイルの検査の誤り（例: ["INGEST_AUTH: ..."]）を、画面に並べて出すために使う。
 */
export function errorDetails(err: unknown): string[] {
  if (!(err instanceof Error)) return [];
  const start = err.message.indexOf("{");
  if (start < 0) return [];
  try {
    const body = JSON.parse(err.message.slice(start)) as { detail?: unknown };
    if (typeof body.detail === "string") return [body.detail];
    if (Array.isArray(body.detail)) return body.detail.filter((item): item is string => typeof item === "string");
  } catch {
    // 本文が JSON でなければ、理由は取り出せない
  }
  return [];
}

/** 通知設定（Discord）の保存の失敗。422 は、送信先の URL の形が合っていない */
export function describeNotificationError(err: unknown): string {
  if (errorStatus(err) === 422) {
    return "通知設定の保存に失敗しました。Discord の Webhook URL（https:// で始まるもの）と、再通知の間隔を確認してください。";
  }
  return describeActionError(err, "通知設定の保存");
}

/** Webhook の追加・切り替えの失敗。422 は、URL が https でない・公開されていないアドレス、など */
export function describeWebhookError(err: unknown, action: string): string {
  if (errorStatus(err) === 422) {
    return `${action}に失敗しました。URL は https:// で始まる、インターネットに公開されたアドレスにしてください（社内ネットワークのアドレスは、サーバーの設定で許可している場合だけ使えます）。`;
  }
  return describeActionError(err, action);
}

/** 機器の追加・所属付け・失効の失敗。409 は名前の重複（追加）か失効済み（所属付け）、422 は入力の不備 */
export function describeDeviceError(err: unknown, action: string): string {
  const status = errorStatus(err);
  if (status === 409 && action === "機器の削除") return `${action}に失敗しました。有効な機器は削除できません。先にキーを失効してください。`;
  if (status === 409) return `${action}に失敗しました。その名前の機器がすでにあるか、失効済みの機器か、別の機器に所属しているセンサーです（付け替えはコマンドで行います）。`;
  if (status === 422) return `${action}に失敗しました。機器名（100 文字まで）と系統（40 文字まで）を確認してください。`;
  return describeActionError(err, action);
}
