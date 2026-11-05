/**
 * 設定画面。タブで、センサー・アラーム・通知・Webhook・データ移行（OSS 版は機器・バックアップも）の各パネルを切り替える。
 * 選んでいるタブだけを描画する（ほかのパネルは作らない＝不要な通信をしない）。
 *
 * 【誰が使うか】App.tsx が、メニューで「設定」を選んだときに出す。引数（props）はない。
 */
import { useState } from "react";

import { AlarmSettingsPanel } from "./settings/AlarmSettingsPanel";
import { BackupSettingsPanel } from "./settings/BackupSettingsPanel";
import { DevicesSettingsPanel } from "./settings/DevicesSettingsPanel";
import { MigrationSettingsPanel } from "./settings/MigrationSettingsPanel";
import { NotificationSettingsPanel } from "./settings/NotificationSettingsPanel";
import { RuntimeSettingsPanel } from "./settings/RuntimeSettingsPanel";
import { SensorSettingsPanel } from "./settings/SensorSettingsPanel";
import { WebhookSettingsPanel } from "./settings/WebhookSettingsPanel";

// 設定画面のタブの種類（値は、下の描画の分岐と対応させる）
type SettingsTab = "sensors" | "alarms" | "notifications" | "webhooks" | "migration" | "backup" | "devices" | "runtime";

// ビルド時に決まる動作モード（.env の VITE_AUTH_MODE）。SaaS 版（multi_tenant）では「バックアップ」は出さない
const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

const BASE_TABS: { value: SettingsTab; label: string; icon: string; hint: string }[] = [
  { value: "sensors", label: "センサー", icon: "📡", hint: "測定する機器" },
  { value: "alarms", label: "アラーム", icon: "🚨", hint: "異常の履歴" },
  { value: "notifications", label: "通知", icon: "🔔", hint: "知らせ方" },
  { value: "webhooks", label: "Webhook連携", icon: "🔗", hint: "外部サービス" },
  { value: "migration", label: "データ移行", icon: "🚚", hint: "書き出し・取り込み" },
];

// OSS 版だけ、最後に「機器」「バックアップ」のタブを足す
const TABS = IS_MULTI_TENANT
  ? BASE_TABS
  : [
      ...BASE_TABS,
      { value: "devices" as const, label: "機器", icon: "🔑", hint: "送信キー" },
      { value: "backup" as const, label: "バックアップ", icon: "💾", hint: "復旧・書き戻し" },
      { value: "runtime" as const, label: "API・取り込み", icon: "⚙️", hint: "取り込みの設定" },
    ];

/** 設定画面の本体。初期表示はセンサーのタブ。 */
export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("sensors");

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h1 className="mb-4 text-2xl font-bold text-gray-900">設定</h1>

      {/* アイコンは飾り（aria-hidden）。ボタンの名前は、従来どおりタブの名前だけにする */}
      <div className={`mb-4 grid grid-cols-3 gap-2 ${TABS.length > 7 ? "sm:grid-cols-8" : TABS.length > 6 ? "sm:grid-cols-7" : TABS.length > 5 ? "sm:grid-cols-6" : "sm:grid-cols-5"}`}>
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            aria-current={tab === t.value ? "page" : undefined}
            className={`flex flex-col items-center gap-0.5 rounded-xl border-2 px-2 py-2 text-sm ${
              tab === t.value
                ? "border-blue-600 bg-blue-50 font-bold text-blue-700"
                : "border-gray-200 bg-white text-gray-600 hover:border-blue-300"
            }`}
          >
            <span aria-hidden="true" className="text-2xl leading-none">
              {t.icon}
            </span>
            <span>{t.label}</span>
            <small aria-hidden="true" className="hidden text-[11px] font-normal text-gray-400 sm:block">
              {t.hint}
            </small>
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        {tab === "sensors" && <SensorSettingsPanel />}
        {tab === "alarms" && <AlarmSettingsPanel />}
        {tab === "notifications" && <NotificationSettingsPanel />}
        {tab === "webhooks" && <WebhookSettingsPanel />}
        {tab === "migration" && <MigrationSettingsPanel />}
        {tab === "devices" && !IS_MULTI_TENANT && <DevicesSettingsPanel />}
        {tab === "backup" && !IS_MULTI_TENANT && <BackupSettingsPanel />}
        {tab === "runtime" && !IS_MULTI_TENANT && <RuntimeSettingsPanel />}
      </div>
    </div>
  );
}
