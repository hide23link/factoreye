/**
 * 設定画面。左のメニュー（項目をまとまりごとに並べる）で、センサー・アラーム・通知・Webhook・データ移行・表示
 * （OSS 版は機器・バックアップ・API・取り込みも）の各パネルを切り替える。スマホでは、メニューが上に並ぶ。
 * 選んでいる項目のパネルだけを描画する（ほかのパネルは作らない＝不要な通信をしない）。
 *
 * 【誰が使うか】App.tsx が、メニューで「設定」を選んだときに出す。引数（props）はない。
 */
import { useState } from "react";

import { AlarmSettingsPanel } from "./settings/AlarmSettingsPanel";
import { BackupSettingsPanel } from "./settings/BackupSettingsPanel";
import { DevicesSettingsPanel } from "./settings/DevicesSettingsPanel";
import { DisplaySettingsPanel } from "./settings/DisplaySettingsPanel";
import { MigrationSettingsPanel } from "./settings/MigrationSettingsPanel";
import { NotificationSettingsPanel } from "./settings/NotificationSettingsPanel";
import { RuntimeSettingsPanel } from "./settings/RuntimeSettingsPanel";
import { SensorSettingsPanel } from "./settings/SensorSettingsPanel";
import { WebhookSettingsPanel } from "./settings/WebhookSettingsPanel";

// 設定画面の項目の種類（値は、下の描画の分岐と対応させる）
type SettingsTab =
  | "sensors"
  | "alarms"
  | "notifications"
  | "webhooks"
  | "migration"
  | "backup"
  | "devices"
  | "runtime"
  | "display";

// ビルド時に決まる動作モード（.env の VITE_AUTH_MODE）。SaaS 版（multi_tenant）では、機器・バックアップ・API・取り込みは出さない
const IS_MULTI_TENANT = import.meta.env.VITE_AUTH_MODE === "multi_tenant";

interface TabItem {
  value: SettingsTab;
  label: string;
  // OSS 版（self-hosted）だけの項目
  ossOnly?: boolean;
}

// メニューのまとまり（見出しと、その中の項目）。項目の名前は、ボタンの名前としてテストでも使う
const GROUPS: { title: string; items: TabItem[] }[] = [
  {
    title: "計測",
    items: [
      { value: "sensors", label: "センサー" },
      { value: "devices", label: "機器", ossOnly: true },
      { value: "alarms", label: "アラーム" },
    ],
  },
  {
    title: "知らせる・つなぐ",
    items: [
      { value: "notifications", label: "通知" },
      { value: "webhooks", label: "Webhook連携" },
    ],
  },
  {
    title: "運用",
    items: [
      { value: "migration", label: "データ移行" },
      { value: "backup", label: "バックアップ", ossOnly: true },
      { value: "runtime", label: "API・取り込み", ossOnly: true },
    ],
  },
  { title: "表示", items: [{ value: "display", label: "画面の明るさ" }] },
];

const VISIBLE_GROUPS = GROUPS.map((group) => ({
  ...group,
  items: group.items.filter((item) => !(item.ossOnly && IS_MULTI_TENANT)),
}));

/** 設定画面の本体。初期表示はセンサー。 */
export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("sensors");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:flex-row md:items-start">
      <nav aria-label="設定の項目" className="flex flex-col gap-3 md:w-48 md:shrink-0">
        <h1 className="px-2 text-lg font-bold tracking-wide text-gray-900">設定</h1>
        {VISIBLE_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-0.5">
            <span className="px-2 text-[11px] font-bold tracking-wider text-gray-500">{group.title}</span>
            <div className="flex flex-wrap gap-1 md:flex-col">
              {group.items.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setTab(item.value)}
                  aria-current={tab === item.value ? "page" : undefined}
                  className={`rounded px-2 py-1.5 text-left text-sm ${
                    tab === item.value
                      ? "bg-gray-100 font-bold text-gray-900 shadow-[inset_2px_0_0_rgb(var(--blue-600))]"
                      : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="min-w-0 flex-1 rounded border border-gray-200 bg-white p-4">
        {tab === "sensors" && <SensorSettingsPanel />}
        {tab === "alarms" && <AlarmSettingsPanel />}
        {tab === "notifications" && <NotificationSettingsPanel />}
        {tab === "webhooks" && <WebhookSettingsPanel />}
        {tab === "migration" && <MigrationSettingsPanel />}
        {tab === "devices" && !IS_MULTI_TENANT && <DevicesSettingsPanel />}
        {tab === "backup" && !IS_MULTI_TENANT && <BackupSettingsPanel />}
        {tab === "runtime" && !IS_MULTI_TENANT && <RuntimeSettingsPanel />}
        {tab === "display" && <DisplaySettingsPanel />}
      </div>
    </div>
  );
}
