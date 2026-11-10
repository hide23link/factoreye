/**
 * 「リンクを作る」の窓。ダッシュボードのグラフ 1 つと「直近 ◯ 分」を選び、そのグラフを 1 画面で開くリンクをコピーする。
 * 右に「開いたときの画面」の小さな見本を出す（LinkScreen の preview）。
 *
 * 【誰が使うか】DashboardView が、見出しの「🔗 リンク」を押したときに出す（グラフが 1 つも無いときは押せない）。
 * 【引数（props）】dashboard = 今のダッシュボード、onClose = 「閉じる」・Esc のとき。
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useSensors } from "../../hooks/queries";
import { buildGraphLinkUrl, graphName, isGraphWidget, LINK_DEFAULT_MINUTES, parseLinkMinutes } from "../../lib/graph-link";
import type { DashboardDetail } from "../../types";
import { LinkScreen } from "./LinkScreen";

/** 「直近」のボタン（分）: 10・30・60 分・3・8 時間 */
const RANGE_CHOICES = [
  { minutes: 10, label: "10 分" },
  { minutes: 30, label: "30 分" },
  { minutes: 60, label: "60 分" },
  { minutes: 180, label: "3 時間" },
  { minutes: 480, label: "8 時間" },
];

/** 「ほか ◯ 分」を打ち終わってから、見本を作り直すまでの時間（ミリ秒）。1 文字ごとに取り直さないため */
const PREVIEW_DELAY_MS = 500;

/** リンクの頭（このページのアドレス。例: https://<アドレス>/） */
function linkBase(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

/** 要素の文字を選ぶ（コピーできない端末で、利用者が自分でコピーできるように） */
function selectText(element: HTMLElement | null) {
  if (!element) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function GraphLinkDialog({ dashboard, onClose }: { dashboard: DashboardDetail; onClose: () => void }) {
  const titleId = useId();
  const { data: sensors } = useSensors();
  const graphs = dashboard.widgets.filter(isGraphWidget);
  const [graphId, setGraphId] = useState(graphs[0]?.id ?? "");
  const [minutes, setMinutes] = useState(LINK_DEFAULT_MINUTES);
  // 「ほか ◯ 分」の入力中の文字。正しい分数（10〜10080）のときだけ、リンクに使う
  const [minutesDraft, setMinutesDraft] = useState(String(LINK_DEFAULT_MINUTES));
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLDivElement>(null);
  const graph = graphs.find((w) => w.id === graphId);
  // 見本の分数。リンクの文字はすぐ変え、見本は打ち終わって少ししてから変える
  const [previewMinutes, setPreviewMinutes] = useState(minutes);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewMinutes(minutes), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [minutes]);
  const url = buildGraphLinkUrl(linkBase(), dashboard.id, graphId, minutes);

  // Esc で閉じる
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const chooseMinutes = (next: number) => {
    setMinutes(next);
    setMinutesDraft(String(next));
    setCopied(false);
  };
  const copy = () => {
    try {
      navigator.clipboard.writeText(url).then(
        () => setCopied(true),
        () => selectText(linkRef.current),
      );
    } catch {
      selectText(linkRef.current);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-full max-w-3xl flex-wrap gap-5 rounded-lg border border-gray-200 bg-white p-4 shadow-xl"
      >
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 text-sm">
          <h2 id={titleId} className="text-base font-bold">
            リンクを作る（{dashboard.name}）
          </h2>
          <label className="flex flex-col gap-1">
            <span className="font-semibold">グラフ</span>
            <select
              value={graphId}
              onChange={(e) => {
                setGraphId(e.target.value);
                setCopied(false);
              }}
              className="w-full rounded-md border border-gray-200 px-2.5 py-1.5"
            >
              {graphs.map((w) => (
                <option key={w.id} value={w.id}>
                  {graphName(w, sensors)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1">
            <span className="font-semibold">直近</span>
            <div role="group" aria-label="直近の分数" className="flex flex-wrap items-center gap-1.5">
              {RANGE_CHOICES.map((choice) => (
                <button
                  key={choice.minutes}
                  type="button"
                  aria-pressed={minutes === choice.minutes}
                  onClick={() => chooseMinutes(choice.minutes)}
                  className={`rounded-md border px-2.5 py-1 ${minutes === choice.minutes ? "border-blue-600 bg-blue-600 text-white" : "border-gray-200"}`}
                >
                  {choice.label}
                </button>
              ))}
              <label className="flex items-center gap-1">
                ほか
                <input
                  type="number"
                  aria-label="ほかの分数"
                  min={10}
                  max={10080}
                  step={5}
                  value={minutesDraft}
                  onChange={(e) => {
                    setMinutesDraft(e.target.value);
                    const next = parseLinkMinutes(`${e.target.value}m`);
                    if (next !== null) chooseMinutes(next);
                  }}
                  // 正しくない数のまま離れたら、使っている分数に戻す
                  onBlur={() => setMinutesDraft(String(minutes))}
                  className="w-20 rounded-md border border-gray-200 px-2 py-1"
                />
                分
              </label>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-semibold">リンク</span>
            <div ref={linkRef} className="select-all break-all rounded bg-gray-100 px-2 py-1.5 font-mono text-xs">
              {url}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            {copied && <span className="mr-auto text-xs font-bold text-green-600">コピーしました</span>}
            <button type="button" onClick={onClose} className="rounded-md border border-gray-200 px-3 py-1.5">
              閉じる
            </button>
            <button type="button" onClick={copy} className="rounded-md bg-blue-600 px-3 py-1.5 font-bold text-white hover:bg-blue-700">
              コピー
            </button>
          </div>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <div aria-hidden="true" className="h-[420px] w-[240px] overflow-hidden rounded-[30px] border-[9px] border-gray-800">
            {graph && <LinkScreen key={`${graph.id}:${previewMinutes}`} widget={graph} rangeMinutes={previewMinutes} preview />}
          </div>
          <small className="text-xs text-gray-500">開いたときの画面</small>
        </div>
      </div>
    </div>,
    document.body,
  );
}
