/**
 * 設定画面。タブで、センサー・アラーム・通知・Webhook・データ移行の各パネルを切り替える。
 * 選んでいるタブだけを描画する（ほかのパネルは作らない＝不要な通信をしない）。
 *
 * 【誰が使うか】App.tsx が、メニューで「設定」を選んだときに出す。引数（props）はない。
 */
import { useState } from "react";

import { AlarmSettingsPanel } from "./settings/AlarmSettingsPanel";
import { MigrationSettingsPanel } from "./settings/MigrationSettingsPanel";
import { NotificationSettingsPanel } from "./settings/NotificationSettingsPanel";
import { SensorSettingsPanel } from "./settings/SensorSettingsPanel";
import { WebhookSettingsPanel } from "./settings/WebhookSettingsPanel";

// 設定画面のタブの種類（値は、下の描画の分岐と対応させる）
type SettingsTab = "sensors" | "alarms" | "notifications" | "webhooks" | "migration";

const TABS: { value: SettingsTab; label: string }[] = [
  { value: "sensors", label: "センサー" },
  { value: "alarms", label: "アラーム" },
  { value: "notifications", label: "通知" },
  { value: "webhooks", label: "Webhook連携" },
  { value: "migration", label: "データ移行" },
];

/** 設定画面の本体。初期表示はセンサーのタブ。 */
export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("sensors");

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">設定</h1>

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            aria-current={tab === t.value ? "page" : undefined}
            className={
              tab === t.value
                ? "shrink-0 border-b-2 border-blue-600 px-3 py-2 text-sm font-medium text-blue-600"
                : "shrink-0 px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        {tab === "sensors" && <SensorSettingsPanel />}
        {tab === "alarms" && <AlarmSettingsPanel />}
        {tab === "notifications" && <NotificationSettingsPanel />}
        {tab === "webhooks" && <WebhookSettingsPanel />}
        {tab === "migration" && <MigrationSettingsPanel />}
      </div>
    </div>
  );
}
