/**
 * 段階 2「テストデータを送る」の中身。
 * 送信コードの例（curl・Arduino・Python のタブとコピー）と、受信待ちの表
 * （サーバーへの接続・受信キー・最後に届いた値を、3 秒ごとに確かめる）、届かないときの原因。
 * 値が届いたら、次の段階へ進めるのは SetupWizard の側（この部品は表示だけ）。
 *
 * 【誰が使うか】SetupWizard（段階 2 のとき）。
 * 【引数（props）】ingestKey・unit = 登録したセンサー、latest = 最後に届いた値（まだ無ければ undefined）、
 *   startedAt = 待ち始めた時刻（ミリ秒）。
 */
import { useEffect, useState } from "react";

import { useNow } from "../../hooks/useNow";
import { useServerCheck } from "../../hooks/useServerCheck";
import { CODE_TABS, ingestSnippets, type CodeTab } from "../../lib/ingest-snippets";
import { formatAge } from "../../lib/overview";
import { formatWaitTime } from "../../lib/setup-progress";
import type { Reading } from "../../types";

/** 届かないときの、よくある原因 3 つ */
const TROUBLE_CAUSES = [
  "取り込みキー（INGEST_API_KEY）が、backend の .env の値と合っていない（キーなしの取り込み INGEST_AUTH=off のときは、キーは不要です）。",
  "上の Ingest Key を打ち間違えている（登録したキーと、1 文字でも違うと届きません）。",
  "機器から、サーバーのアドレスに届いていない（http と https の違い、別のネットワーク、ファイアウォール）。",
];

/** 表の右端の ■（緑 = 確認できた、橙 = まだ、赤 = だめ） */
function Light({ tone }: { tone: "ok" | "wait" | "bad" }) {
  const color = tone === "ok" ? "var(--fe-ok)" : tone === "wait" ? "var(--fe-amb)" : "var(--fe-red)";
  const label = tone === "ok" ? "確認できました" : tone === "wait" ? "まだです" : "確認できません";
  return (
    <span style={{ color }} role="img" aria-label={label}>
      ■
    </span>
  );
}

export function SendDataPanel({ ingestKey, unit, latest, startedAt }: { ingestKey: string; unit: string; latest: Reading | undefined; startedAt: number }) {
  const [tab, setTab] = useState<CodeTab>("curl");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [troubleOpen, setTroubleOpen] = useState(false);
  const now = useNow(1000);
  const server = useServerCheck(true);
  const snippet = ingestSnippets(ingestKey)[tab];

  // 「コピーしました」の表示は、少しして元に戻す（画面を離れるときは、戻す予約も取り消す）
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);

  // クリップボードが使えない環境（http のページなど）では、コピーできなかったことを伝える（コードは選んでコピーできる）
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="overflow-hidden rounded border" style={{ borderColor: "var(--fe-line)", background: "var(--fe-chrome)" }}>
        <div className="flex items-center border-b pr-2" style={{ borderColor: "var(--fe-line)" }}>
          {CODE_TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              onClick={() => setTab(item.value)}
              className="border-b-2 px-3.5 py-2 text-xs"
              style={tab === item.value ? { color: "var(--fe-ink)", borderColor: "var(--fe-cy)" } : { color: "var(--fe-mut)", borderColor: "transparent" }}
            >
              {item.label}
            </button>
          ))}
          <span className="flex-1" />
          <button type="button" onClick={() => void copy()} className="h-7 rounded border border-gray-300 bg-white px-3 text-xs hover:bg-gray-50">
            {copyState === "copied" ? "コピーしました" : copyState === "failed" ? "コピーできません" : "コピー"}
          </button>
        </div>
        <pre className="m-0 overflow-x-auto whitespace-pre p-3.5 font-num text-xs leading-7 text-gray-800">{snippet}</pre>
      </div>
      {copyState === "failed" && (
        <p role="alert" className="text-xs text-red-600">
          コピーできませんでした。コードを選んでコピーしてください。
        </p>
      )}
      {tab === "arduino" && (
        <p className="text-xs text-gray-500">
          ライブラリの入手方法・詳細は <code>clients/arduino-m5stack/README.md</code> を参照してください。
        </p>
      )}
      {tab === "python" && (
        <p className="text-xs text-gray-500">
          入手方法・詳細は <code>clients/raspberry-pi/README.md</code> を参照してください。
        </p>
      )}
      <p className="text-xs text-gray-500">
        <code>INGEST_API_KEY</code> は backend の <code>.env</code> に設定した値に置き換えます。backend を{" "}
        <code>INGEST_AUTH=off</code> で動かしている場合は、キーは不要です（curl は <code>X-API-Key</code> の行を外し、Arduino・Python は空文字{" "}
        <code>&quot;&quot;</code> を渡します）。
      </p>

      <div className="flex flex-col gap-2.5 rounded border p-3" style={{ borderColor: "var(--fe-line)", background: "var(--fe-panel)" }}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-num text-xs font-bold" style={{ color: latest ? "var(--fe-ok)" : "var(--fe-amb)" }}>
            ● {latest ? "受信しました" : "受信待ち"}
          </span>
          <span className="min-w-[12rem] flex-1 text-xs text-gray-500">3 秒ごとに確かめています。届くと自動で次へ進みます</span>
          <span className="font-num text-xs text-gray-500">
            待ち時間 <b style={{ color: "var(--fe-ink)" }}>{formatWaitTime(now - startedAt)}</b>
          </span>
        </div>
        <dl className="grid grid-cols-[8.75rem_1fr_auto] items-center gap-x-3 gap-y-1.5 font-num text-xs">
          <dt className="text-gray-500">サーバー</dt>
          <dd>{server.status === "ok" ? `接続 OK\u3000応答 ${server.responseMs} ms` : server.status === "down" ? "接続できません" : "確認中…"}</dd>
          <dd>
            <Light tone={server.status === "ok" ? "ok" : server.status === "down" ? "bad" : "wait"} />
          </dd>
          <dt className="text-gray-500">受信キー</dt>
          <dd className="break-all">{ingestKey}&emsp;登録済み</dd>
          <dd>
            <Light tone="ok" />
          </dd>
          <dt className="text-gray-500">最後に届いた値</dt>
          <dd style={latest ? undefined : { color: "var(--fe-mut)" }}>
            {latest ? `${latest.value} ${unit}\u3000${formatAge(now - new Date(latest.recordedAt).getTime())}` : "まだありません"}
          </dd>
          <dd>
            <Light tone={latest ? "ok" : "wait"} />
          </dd>
        </dl>
        <div>
          <button type="button" aria-expanded={troubleOpen} onClick={() => setTroubleOpen((open) => !open)} className="text-xs text-blue-600 hover:underline">
            届かないとき（よくある原因 3 つ）
          </button>
          {troubleOpen && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-gray-600">
              {TROUBLE_CAUSES.map((cause) => (
                <li key={cause}>{cause}</li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
