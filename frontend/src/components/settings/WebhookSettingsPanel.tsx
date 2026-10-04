import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useWebhookSubscriptions } from "../../hooks/queries";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  updateWebhookSubscription,
} from "../../lib/api";
import type { WebhookEventType, WebhookSubscription } from "../../types";

const EVENT_LABELS: Record<WebhookEventType, string> = {
  "reading.received": "センサー値を受信するたび",
  "alarm.triggered": "アラームが発生するたび",
};

function WebhookRow({ webhook }: { webhook: WebhookSubscription }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["webhook-subscriptions"] });
  };

  const toggleMutation = useMutation({
    mutationFn: () => updateWebhookSubscription(webhook.id, { enabled: !webhook.enabled }),
    onSuccess: () => {
      invalidate();
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteWebhookSubscription(webhook.id),
    onSuccess: () => {
      invalidate();
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-500">{EVENT_LABELS[webhook.eventType]}</p>
          <p className="truncate text-sm text-gray-900">{webhook.url}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending}
            className={
              webhook.enabled
                ? "rounded-full bg-green-100 px-3 py-1 text-xs text-green-700 hover:bg-green-200"
                : "rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-500 hover:bg-gray-200"
            }
          >
            {webhook.enabled ? "有効" : "無効"}
          </button>
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="text-xs text-gray-400 hover:text-red-600"
          >
            削除
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function AddWebhookForm() {
  const queryClient = useQueryClient();
  const [eventType, setEventType] = useState<WebhookEventType>("reading.received");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => createWebhookSubscription({ eventType, url }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webhook-subscriptions"] });
      setUrl("");
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-dashed border-gray-300 p-3 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!url.trim()) {
          setError("URLを入力してください");
          return;
        }
        createMutation.mutate();
      }}
    >
      <label className="text-sm sm:w-48">
        タイミング
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as WebhookEventType)}
          className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        >
          {Object.entries(EVENT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex-1 text-sm">
        Webhook URL
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.zapier.com/..."
          className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={createMutation.isPending}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
      >
        追加
      </button>
      {error && <p className="text-xs text-red-600 sm:basis-full">{error}</p>}
    </form>
  );
}

export function WebhookSettingsPanel() {
  const { data: webhooks, isLoading } = useWebhookSubscriptions();

  return (
    <div>
      <h2 className="mb-1 text-lg font-bold text-gray-900">Webhook連携</h2>
      <p className="mb-4 text-xs text-gray-400">
        Zapier・Make・n8n等のノーコード自動化サービスで受け口（Webhook URL）を作り、ここに貼り付けるだけで連携できます。コードを書く必要はありません。センサー値の受信・アラームの発生をきっかけに、指定したURLへ通知を送ります。
      </p>

      {isLoading && <p className="text-sm text-gray-400">読み込み中...</p>}

      {!isLoading && (
        <div className="space-y-2">
          {webhooks?.map((webhook) => (
            <WebhookRow key={webhook.id} webhook={webhook} />
          ))}
          <AddWebhookForm />
        </div>
      )}
    </div>
  );
}
