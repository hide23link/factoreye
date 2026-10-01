import { useState } from "react";

import { AlarmSettingsPanel } from "./settings/AlarmSettingsPanel";
import { PluginSettingsPanel } from "./settings/PluginSettingsPanel";
import { SensorSettingsPanel } from "./settings/SensorSettingsPanel";

type SettingsTab = "sensors" | "alarms" | "plugins";

const TABS: { value: SettingsTab; label: string }[] = [
  { value: "sensors", label: "センサー" },
  { value: "alarms", label: "アラーム" },
  { value: "plugins", label: "プラグイン" },
];

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("sensors");

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">設定</h1>

      <div className="mb-4 flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={
              tab === t.value
                ? "border-b-2 border-blue-600 px-3 py-2 text-sm font-medium text-blue-600"
                : "px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        {tab === "sensors" && <SensorSettingsPanel />}
        {tab === "alarms" && <AlarmSettingsPanel />}
        {tab === "plugins" && <PluginSettingsPanel />}
      </div>
    </div>
  );
}
