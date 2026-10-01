import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { usePlugins } from "../../hooks/queries";
import { disablePlugin, enablePlugin, updatePluginConfig } from "../../lib/api";
import type { Plugin } from "../../types";

// OQ-8方針: 単純項目はフォーム、複雑な設定はJSONエディタにフォールバック。
// プラグインごとのconfigスキーマをFrontendは知らないため、Phase 0はJSONエディタのみ提供する。
function ConfigEditor({ plugin }: { plugin: Plugin }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(JSON.stringify(plugin.config, null, 2));
  const [error, setError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: (config: Record<string, unknown>) => updatePluginConfig(plugin.name, config),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const handleSave = () => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("JSONオブジェクト（{...}）である必要があります");
        return;
      }
      saveMutation.mutate(parsed as Record<string, unknown>);
    } catch {
      setError("JSONとして解析できません");
    }
  };

  return (
    <div className="mt-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        spellCheck={false}
        className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs"
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <button
        type="button"
        onClick={handleSave}
        disabled={saveMutation.isPending}
        className="mt-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
      >
        設定を保存
      </button>
    </div>
  );
}

function PluginRow({ plugin }: { plugin: Plugin }) {
  const queryClient = useQueryClient();
  const [isConfigOpen, setConfigOpen] = useState(false);

  const toggleMutation = useMutation({
    mutationFn: () => (plugin.enabled ? disablePlugin(plugin.name) : enablePlugin(plugin.name)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["plugins"] }),
  });

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-medium text-gray-900">{plugin.name}</p>
          <p className="text-xs text-gray-400">v{plugin.version}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setConfigOpen((v) => !v)}
            className="text-xs text-gray-500 hover:text-blue-600"
          >
            設定
          </button>
          <button
            type="button"
            onClick={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending}
            className={
              plugin.enabled
                ? "rounded-full bg-green-100 px-3 py-1 text-xs text-green-700 hover:bg-green-200"
                : "rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-500 hover:bg-gray-200"
            }
          >
            {plugin.enabled ? "有効" : "無効"}
          </button>
        </div>
      </div>
      {isConfigOpen && <ConfigEditor plugin={plugin} />}
    </div>
  );
}

export function PluginSettingsPanel() {
  const { data: plugins, isLoading } = usePlugins();

  return (
    <div>
      <h2 className="mb-1 text-lg font-bold text-gray-900">プラグイン</h2>
      <p className="mb-3 text-xs text-gray-400">
        サードパーティプラグインはサンドボックス化されていません（Phase 0の既知の制限）。信頼できるプラグインのみ有効化してください。
      </p>

      {isLoading && <p className="text-sm text-gray-400">読み込み中...</p>}

      {!isLoading && plugins?.length === 0 && (
        <p className="text-sm text-gray-400">
          プラグインが見つかりません。backend/app/plugins/installed/ にプラグインを配置してください。
        </p>
      )}

      <div className="space-y-2">
        {plugins?.map((plugin) => (
          <PluginRow key={plugin.id} plugin={plugin} />
        ))}
      </div>
    </div>
  );
}
