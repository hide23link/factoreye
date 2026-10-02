import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useNotificationSettings } from "../../hooks/queries";
import { updateNotificationSettings } from "../../lib/api";

export function NotificationSettingsPanel() {
  const { data, isLoading } = useNotificationSettings();
  const queryClient = useQueryClient();

  const [webhookUrlCritical, setWebhookUrlCritical] = useState("");
  const [webhookUrlWarning, setWebhookUrlWarning] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [repeatIntervalMinutes, setRepeatIntervalMinutes] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // サーバーから取得できたら入力欄の初期値として反映する（以後はローカル編集を優先）
  useEffect(() => {
    if (data) {
      setWebhookUrlCritical(data.discordWebhookUrlCritical);
      setWebhookUrlWarning(data.discordWebhookUrlWarning);
      setEnabled(data.enabled);
      setRepeatEnabled(data.criticalRepeatEnabled);
      setRepeatIntervalMinutes(data.criticalRepeatIntervalMinutes);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      updateNotificationSettings({
        discordWebhookUrlCritical: webhookUrlCritical,
        discordWebhookUrlWarning: webhookUrlWarning,
        enabled,
        criticalRepeatEnabled: repeatEnabled,
        criticalRepeatIntervalMinutes: repeatIntervalMinutes,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notification-settings"] });
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div>
      <h2 className="mb-3 text-lg font-bold text-gray-900">通知</h2>
      <p className="mb-4 text-sm text-gray-500">
        アラーム発生時にDiscordへ通知します。重故障と軽故障を別々のチャンネル（Webhook URL）に送り分けられます。重故障は通常送信（通知音・プッシュあり）、軽故障はサイレント送信（チャンネルには表示されるが通知音・プッシュ無し）になります。
      </p>

      {isLoading && <p className="text-sm text-gray-400">読み込み中...</p>}

      {!isLoading && (
        <form
          className="max-w-xl space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveMutation.mutate();
          }}
        >
          <label className="block text-sm">
            🚨 重故障用 Discord Webhook URL
            <input
              type="url"
              value={webhookUrlCritical}
              onChange={(e) => setWebhookUrlCritical(e.target.value)}
              placeholder="https://discord.com/api/webhooks/..."
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </label>

          <div className="rounded border border-gray-200 bg-gray-50 p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={repeatEnabled}
                onChange={(e) => setRepeatEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              重故障が解決しないまま一定時間が経過したら再通知する
            </label>
            <div className="mt-2 flex items-center gap-2 text-sm text-gray-600">
              <span>再通知の間隔:</span>
              <input
                type="number"
                min={1}
                value={repeatIntervalMinutes}
                disabled={!repeatEnabled}
                onChange={(e) => setRepeatIntervalMinutes(Number(e.target.value))}
                className="w-20 rounded border border-gray-300 px-2 py-1 disabled:bg-gray-100 disabled:text-gray-400"
              />
              <span>分</span>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              チェックを外すと、重故障は発生時に1回だけ通知します。
            </p>
          </div>

          <label className="block text-sm">
            ⚠️ 軽故障用 Discord Webhook URL
            <input
              type="url"
              value={webhookUrlWarning}
              onChange={(e) => setWebhookUrlWarning(e.target.value)}
              placeholder="https://discord.com/api/webhooks/..."
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </label>
          <p className="text-xs text-gray-400">
            Discordサーバーの「連携サービス」→「ウェブフック」で作成したURLを指定します。同じチャンネルに送る場合は両方に同じURLを指定してください。
          </p>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            通知を有効にする
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saveMutation.isPending}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              保存
            </button>
            {saved && <span className="text-xs text-green-600">保存しました</span>}
          </div>
        </form>
      )}
    </div>
  );
}
