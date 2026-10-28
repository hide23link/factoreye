// 「書き戻し」「R2 から復旧する」の画面が共有する、文言と書式。
// 【誰が使うか】FailbackCard.tsx、R2RestoreCard.tsx、FailbackResultTable.tsx。

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP");
}


// 書き戻しの前に、管理者に必ず伝えること
export const LIMITATION =
  "控えの稼働中に行われた、既存の行の更新・削除（パスワードの変更など）は戻りません。" +
  "また、本番に復帰したあとに削除したセンサー・ダッシュボード・ウィジェット・Webhook・利用者は、" +
  "引き継ぎに残っていれば復活します。";

// 時間切れ（504）のときに足す案内。書き込みは復旧ツールの中で続いているかもしれない
export const TIMEOUT_HINT = "再度試算して、追加が 0 件なら、書き戻しは完了しています。";

// 表の名前を、画面の言葉にする（知らない表は、そのまま出す）
export const TABLE_LABELS: Record<string, string> = {
  users: "利用者",
  workspaces: "ワークスペース",
  sensors: "センサー",
  readings: "測定値",
  alarms: "アラーム",
  dashboards: "ダッシュボード",
  widgets: "ウィジェット",
  webhook_subscriptions: "Webhook",
  notification_settings: "通知設定",
};

