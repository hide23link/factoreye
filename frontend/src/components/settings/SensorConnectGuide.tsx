/**
 * センサーを登録したあとに出す「つなぎ方」の案内。
 * Ingest Key（コピーできる）と、送信コードの例を見せ、最初のデータが届くのを待って、届いたら知らせる。
 *
 * 【誰が使うか】SensorSettingsPanel（登録に成功した直後。「閉じる」を押すまで出す）。
 * 【引数（props）】sensor = 登録したセンサー、onClose = 閉じる。
 */
import { useEffect, useState } from "react";

import { useSensorReadings } from "../../hooks/queries";
import { API_BASE_URL } from "../../lib/api";
import { CODE_TABS, ingestSnippets, type CodeTab } from "../../lib/ingest-snippets";
import type { Sensor } from "../../types";

type GuideSensor = Pick<Sensor, "id" | "name" | "ingestKey" | "unit">;

export function SensorConnectGuide({ sensor, onClose }: { sensor: GuideSensor; onClose: () => void }) {
  const [tab, setTab] = useState<CodeTab>("curl");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  // 「コピーしました」「コピーできません」の表示は少しして元に戻す（閉じたときは、戻す予約も取り消す）
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);
  // 直近 24 時間に1件でもあれば「届いた」とみなす（5 秒ごとに自動で確認する）
  const { data } = useSensorReadings(sensor.id, 24, 1);
  const latest = data?.readings[0];

  // クリップボードが使えない環境（http のページなど）では、コピーできなかったことを伝える（キーは画面に出ているので、選んでコピーできる）
  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(sensor.ingestKey);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section aria-label="センサーのつなぎ方" className="mb-4 rounded-lg border-2 border-blue-600 bg-white p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-gray-900">
          ✅ 「{sensor.name}」を登録しました。次は、機器からデータを送ります
        </p>
        <button type="button" onClick={onClose} className="shrink-0 rounded px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100">
          閉じる
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-gray-50 p-2 text-sm">
        <span className="text-xs text-gray-500">🔑 Ingest Key</span>
        <code className="min-w-0 flex-1 truncate">{sensor.ingestKey}</code>
        <button type="button" onClick={() => void copyKey()} className="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs hover:bg-gray-50">
          {copyState === "copied" ? "✔ コピーしました" : "📋 コピー"}
        </button>
        {copyState === "failed" && (
          <span role="alert" className="basis-full text-xs text-red-600">
            コピーできませんでした。キーを選んでコピーしてください。
          </span>
        )}
      </div>

      <div className="mb-2 flex gap-1 border-b border-gray-200">
        {CODE_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={
              tab === t.value
                ? "border-b-2 border-blue-600 px-2 py-1.5 text-xs font-medium text-blue-600"
                : "px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <pre className="mb-2 overflow-x-auto rounded bg-gray-900 p-3 text-xs text-gray-100">{ingestSnippets(sensor.ingestKey)[tab]}</pre>
      <p className="mb-2 text-xs text-gray-500">
        URL（<code>{API_BASE_URL}</code>）と <code>INGEST_API_KEY</code> は、自分の環境の値に置き換えます（<code>INGEST_API_KEY</code> は backend の <code>.env</code> の値。<code>INGEST_AUTH=off</code> ならキーは不要です）。
      </p>

      {latest ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm font-medium text-green-700">
          ✅ 最初のデータが届きました（{latest.value}
          {sensor.unit && ` ${sensor.unit}`}）。ダッシュボードの編集で、このセンサーを置けます。
        </p>
      ) : (
        <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
          ⏳ データが届くのを待っています…（5 秒ごとに自動で確認します）
        </p>
      )}
    </section>
  );
}
